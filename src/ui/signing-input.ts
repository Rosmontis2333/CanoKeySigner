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
