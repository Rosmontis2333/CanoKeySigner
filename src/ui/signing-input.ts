import { base64 } from '@scure/base';
import { decodePsbt } from '../chains/bitcoin/transaction';
import { bytesToHex } from '@noble/hashes/utils.js';
import { strictJson } from '../signing/json';
import { decodeSolana } from '../chains/solana/codec';
import { decodeSolanaEnvelope } from '../chains/solana/transaction';

export function detectEvmInput(source: string): 'transaction' | 'personal_sign' | 'eth_signTypedData_v4' {
  const text = source.trim();
  if (!text) throw new Error('请输入完整签名内容');
  if (/^[{\[]/.test(text)) {
    const value = strictJson(text);
    if (value && typeof value === 'object' && ['types', 'primaryType', 'domain', 'message'].some((key) => key in value)) return 'eth_signTypedData_v4';
    return 'transaction';
  }
  // Encoded or malformed transaction bytes must never fall through to text signing.
  return /^0x/i.test(text) || /^[a-fA-F0-9]+$/.test(text) ? 'transaction' : 'personal_sign';
}

export function detectSolanaInput(source: string, encoding: string): {
  kind: 'transaction' | 'offchain-text' | 'offchain-import'; format: 'transaction' | 'message';
} {
  const text = source.trim();
  if (!text) throw new Error('请输入完整签名内容');
  const compact = text.replace(/[\r\n]/g, '');
  const encoded = encoding === 'binary' || /^0x/i.test(text) || /^[a-fA-F0-9]+$/.test(compact)
    || /^[A-Za-z0-9+/=]+$/.test(compact) && (compact.length >= 32 || /[+/=]/.test(compact));
  if (!encoded) return { kind: 'offchain-text', format: 'message' };
  const bytes = decodeSolana(text, encoding);
  if (bytesToHex(bytes.slice(0, 16)) === 'ff736f6c616e61206f6666636861696e') return { kind: 'offchain-import', format: 'message' };
  const formats = (['transaction', 'message'] as const).filter((format) => {
    try { decodeSolanaEnvelope(text, encoding, format); return true; } catch { return false; }
  });
  if (formats.length !== 1) throw new Error(formats.length ? 'Solana 输入格式存在歧义，请检查原始数据' : '无法识别 Solana 交易或消息，请检查完整内容及所选编码');
  return { kind: 'transaction', format: formats[0]! };
}

export function detectBitcoinInput(source: string) {
  const text = source.replace(/\s/g, '').replace(/^0x/i, '');
  const encoding = /^(?:[a-fA-F0-9]{2})+$/.test(text) ? 'hex' : 'base64';
  const bytes = decodePsbt(text, encoding);
  if (bytesToHex(bytes.slice(0, 5)) !== '70736274ff') throw new Error('未识别到有效 PSBT 文件头');
  return { source: text, encoding, kind: 'transaction', format: 'transaction' };
}

export function detectAutomaticSolanaInput(source: string) {
  const candidates = [];
  for (const encoding of ['hex', 'base64', 'base58']) {
    const compact = source.replace(/\s/g, '');
    const text = encoding === 'hex' ? compact.replace(/^0x/i, '') : compact;
    try {
      const detected = detectSolanaInput(text, encoding);
      if (detected.kind !== 'offchain-text') candidates.push({ ...detected, source: text, encoding });
    } catch { /* Try the remaining encodings against the complete structure. */ }
  }
  if (candidates.length > 1) throw new Error('Solana 编码存在歧义，请检查原始数据');
  if (candidates.length === 1) return candidates[0]!;
  const detected = detectSolanaInput(source, 'base64');
  if (detected.kind !== 'offchain-text') throw new Error('无法识别 Solana 编码');
  return { ...detected, source, encoding: 'base64' };
}

export function decodeSigningFile(bytes: Uint8Array, chain: 'bitcoin' | 'solana'): string {
  const encoded = base64.encode(bytes);
  try {
    const detected = chain === 'bitcoin' ? detectBitcoinInput(encoded) : detectAutomaticSolanaInput(encoded);
    if (detected.kind !== 'offchain-text') return encoded;
  } catch { /* Text files follow the same recognition rules as pasted input. */ }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('文件未包含可识别的交易或 UTF-8 消息');
  if (chain === 'bitcoin') detectBitcoinInput(text);
  else detectAutomaticSolanaInput(text);
  return text;
}
