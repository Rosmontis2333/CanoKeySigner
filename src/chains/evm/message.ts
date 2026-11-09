import { addr, eip191Signer, verifyTyped, serializeSignature } from 'micro-eth-signer';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { reviewTypedData } from './typed-data';
import { verifyEvmCompactSignature } from './signature';
import { evmNetworkLabel } from './networks';

export type EvmMessageMethod = 'personal_sign' | 'eth_signTypedData_v4';
export interface EvmMessageReview {
  readonly kind: 'message';
  readonly chain: 'evm';
  readonly method: EvmMessageMethod;
  readonly content: string;
  readonly digestHex: string;
  readonly publicKeyHex: string;
  readonly sender: string;
  readonly chainId: string;
  readonly signable: true;
  readonly rows: readonly (readonly [string, string])[];
}
const reviews = new WeakSet<EvmMessageReview>();
const hiddenCharacters = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
function displayJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(hiddenCharacters, (character) => {
    // Preserve pretty-print newlines outside strings. JSON already escapes string controls.
    if (character === '\n') return character;
    return character.split('').map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  });
}

export function prepareEvmMessage(
  method: EvmMessageMethod, source: string, publicKeyHex: string, expectedChainId?: string,
  encoding: 'utf8' | 'hex' = 'utf8',
): EvmMessageReview {
  if (!['personal_sign', 'eth_signTypedData_v4'].includes(method)) throw new Error('不支持的 EVM 消息签名方法');
  if (source.length > 262144) throw new Error('消息超过 256 KiB');
  if (expectedChainId !== undefined && (!/^[1-9][0-9]*$/.test(expectedChainId) || expectedChainId.length > 78 || BigInt(expectedChainId) >= 1n << 256n)) {
    throw new Error('消息审查需要有效的当前 chainId');
  }
  const sender = addr.fromPublicKey(hexToBytes(publicKeyHex));
  const rows: [string, string][] = [['签名方法', method], ['签名账户', sender]];
  let chainId = expectedChainId ?? '';
  let content: string, digestHex: string;
  if (method === 'personal_sign') {
    if (chainId) rows.push(['请求网络（会话上下文）', evmNetworkLabel(chainId)]);
    if (encoding === 'hex' && !/^0x(?:[0-9a-fA-F]{2})*$/.test(source)) throw new Error('personal_sign 需要完整 Hex 消息字节');
    const bytes = encoding === 'hex' ? hexToBytes(source.slice(2)) : new TextEncoder().encode(source);
    if (!bytes.length || bytes.length > 16384) throw new Error('personal_sign 可阅读消息需要 1–16384 字节');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (encoding === 'utf8' && text !== source) throw new Error('消息含有不完整 Unicode');
    // Refuse binary/control payloads. Newline, tab and CR are visible in the escaped review.
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replace(/[\t\n\r]/g, ''))) throw new Error('消息含有控制或隐藏字符');
    content = bytesToHex(bytes);
    digestHex = eip191Signer.getHash(bytes).replace(/^0x/, '');
    rows.push(['消息正文（JSON 转义）', displayJson(text)], ['消息字节数', String(bytes.length)], ['消息原始 Hex', `0x${content}`],
      ['签名范围', 'EIP-191 personal_sign 前缀与精确消息字节。签名可被其他网络复用，请核对正文中的网站、账户和用途。']);
  } else {
    const typed = reviewTypedData(source, expectedChainId);
    chainId = typed.chainId;
    content = typed.json;
    digestHex = typed.digestHex;
    const data = JSON.parse(content) as Record<string, unknown>;
    rows.push(['网络（来自 Domain）', evmNetworkLabel(chainId)], ['Domain', displayJson(data.domain)], ['主类型', String(data.primaryType)], ['完整类型定义', displayJson(data.types)],
      ['完整消息字段', displayJson(data.message)], ['Domain hash', typed.domainHashHex], ['Message hash', typed.messageHashHex],
      ['授权效果', '按完整类型和字段签署结构化消息。合约可能据此执行授权、订单或资产操作，请核对全部字段与验证合约。']);
  }
  rows.push(['精确签名摘要', digestHex]);
  const review: EvmMessageReview = Object.freeze({
    kind: 'message', chain: 'evm', method, content, digestHex, publicKeyHex, sender, chainId, signable: true,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
  reviews.add(review);
  return review;
}

export function assertEvmMessageReview(review: EvmMessageReview): void {
  if (!reviews.has(review)) throw new Error('消息审查对象无效，请重新审查');
}

export function attachEvmMessageSignature(review: EvmMessageReview, signature: Uint8Array): string {
  assertEvmMessageReview(review);
  const { normalized, yParity } = verifyEvmCompactSignature(hexToBytes(review.digestHex), signature, hexToBytes(review.publicKeyHex));
  const result = serializeSignature({ r: normalized.r, s: normalized.s, yParity });
  const valid = review.method === 'personal_sign'
    ? eip191Signer.verify(result, hexToBytes(review.content), review.sender)
    : verifyTyped(result, JSON.parse(review.content), review.sender);
  if (!valid) throw new Error('消息签名未通过协议独立复核');
  return result;
}
