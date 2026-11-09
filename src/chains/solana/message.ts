import { base58, base64 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { concat, decodeSolana, Reader } from './codec';

const DOMAIN = hexToBytes('ff736f6c616e61206f6666636861696e');
const MAX_MESSAGE_BYTES = 1331;
export interface SolanaMessageReview {
  readonly kind: 'solana-message';
  readonly chain: 'solana';
  readonly method: 'solana_signMessage';
  readonly publicKeyHex: string;
  readonly network: string;
  readonly messageHex: string;
  readonly version: 0 | 1;
  readonly signers: readonly string[];
  readonly signable: boolean;
  readonly rows: readonly (readonly [string, string])[];
}
const reviews = new WeakSet<SolanaMessageReview>();

function checkKey(bytes: Uint8Array): void {
  if (bytes.length !== 32) throw new Error('Solana 消息需要 32 字节 Ed25519 公钥');
  const point = ed25519.Point.fromBytes(bytes, false);
  if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('Ed25519 公钥无效');
}
function readable(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!text.trim()) throw new Error('消息正文不能为空');
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replace(/[\t\n\r]/g, ''))) throw new Error('消息正文包含控制或隐藏字符');
  return text;
}

/** Manual text becomes a standard v1 message containing the selected required signer. */
export function prepareSolanaTextMessage(source: string, publicKeyHex: string, network: string): SolanaMessageReview {
  if (source.length > MAX_MESSAGE_BYTES) throw new Error('消息正文超出设备容量');
  const content = new TextEncoder().encode(source);
  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content) !== source) throw new Error('消息含有不完整 Unicode');
  const key = hexToBytes(publicKeyHex);
  checkKey(key);
  return prepareSolanaMessage(base64.encode(concat(DOMAIN, Uint8Array.of(1, 1), key, content)), publicKeyHex, network);
}

/** WalletConnect/import signs only the supplied, already domain-separated bytes. */
export function prepareSolanaMessage(source: string, publicKeyHex: string, network: string, encoding = 'base64'): SolanaMessageReview {
  if (!['mainnet-beta', 'devnet', 'testnet'].includes(network)) throw new Error('请选择明确的 Solana cluster');
  const key = hexToBytes(publicKeyHex);
  checkKey(key);
  const bytes = decodeSolana(source, encoding);
  if (bytes.length > MAX_MESSAGE_BYTES) throw new Error('完整离链消息超出 CanoKey 1331 字节容量');
  const reader = new Reader(bytes);
  if (bytesToHex(reader.take(16)) !== bytesToHex(DOMAIN)) throw new Error('消息需要 Solana offchain 域分离格式，原始文本或交易字节请使用对应入口');
  const version = reader.byte();
  if (version !== 0 && version !== 1) throw new Error('当前支持 Solana offchain v0 / v1');
  const rows: [string, string][] = [['签名方法', 'solana_signMessage'], ['离链消息格式', `Solana offchain v${version}`],
    ['签名账户', base58.encode(key)], ['所选 cluster（外部上下文）', network],
    ['网络绑定范围', '离链格式不包含 cluster chainId，所选网络用于本次审查上下文，签名可跨网络复用']];
  let format: number | undefined;
  if (version === 0) {
    rows.push(['Application domain（消息声明）', base58.encode(reader.take(32))]);
    format = reader.byte();
    if (format > 2) throw new Error('Solana offchain v0 的消息格式无效');
    if (format < 2 && bytes.length > 1232) throw new Error('Solana offchain v0 格式 0/1 最多 1232 字节');
  }
  const count = reader.byte();
  if (!count || count * 32 >= bytes.length - reader.offset) throw new Error('离链消息 signer 数量或正文长度无效');
  const signers: string[] = [];
  let previousHex: string | undefined;
  for (let index = 0; index < count; index++) {
    const signer = reader.take(32);
    checkKey(signer);
    const hex = bytesToHex(signer);
    if (version === 1 && previousHex !== undefined && hex <= previousHex) throw new Error('v1 signers 必须按公钥字节递增且不重复');
    previousHex = hex;
    signers.push(base58.encode(signer));
    rows.push([`Required signer ${index + 1}`, base58.encode(signer)]);
  }
  if (new Set(signers).size !== signers.length) throw new Error('离链消息包含重复 signer');
  let content: Uint8Array;
  if (version === 0) {
    const length = reader.byte() | (reader.byte() << 8);
    content = reader.take(length);
    reader.end();
    if (format === 0 && content.some((byte) => byte < 0x20 || byte > 0x7e)) throw new Error('v0 格式 0 仅允许可打印 ASCII');
  } else content = reader.take(bytes.length - reader.offset);
  const text = readable(content);
  const signable = signers.includes(base58.encode(key));
  rows.push(['消息正文（JSON 转义）', JSON.stringify(text)], ['正文字节数', String(content.length)],
    ['完整签名字节数', String(bytes.length)], ['完整消息长度上限', '1331 字节（v0 格式 0/1 为 1232 字节）'], ['完整签名消息 Hex', bytesToHex(bytes)],
    ['授权效果', '精确签署域分离头、所列 signer 和全部正文。接收方可将签名用于登录或其他链下授权，请核对正文中的网站、nonce、时间和用途'],
    ['多方签名范围', '本次只生成当前账户的一份签名。接收方仍须验证消息结构及所有 required signer 的签名']);
  if (!signable) rows.push(['当前账户', '未列入 required signers，当前拒签']);
  const review: SolanaMessageReview = Object.freeze({ kind: 'solana-message', chain: 'solana', method: 'solana_signMessage', publicKeyHex, network,
    messageHex: bytesToHex(bytes), version, signers: Object.freeze(signers), signable,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))) });
  reviews.add(review);
  return review;
}

export function assertSolanaMessageReview(review: SolanaMessageReview): void {
  if (!reviews.has(review) || !review.signable) throw new Error('离链消息审查对象无效或当前账户不属于 signer');
}
export function verifySolanaMessageSignature(review: SolanaMessageReview, signature: Uint8Array): Uint8Array {
  assertSolanaMessageReview(review);
  if (signature.length !== 64 || !ed25519.verify(signature, hexToBytes(review.messageHex), hexToBytes(review.publicKeyHex), { zip215: false })) {
    throw new Error('Solana 离链消息签名未通过精确字节验签');
  }
  return Uint8Array.from(signature);
}
