import { base58 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeSolana, Reader, parseMessage, resolveLookups, concat, shortVector, addressBytes } from './codec';
import { reviewInstructions } from './instructions';
import type { Account } from './instructions';
import { parseV1Message } from './v1';

export interface SolanaReview {
  readonly chain: 'solana';
  readonly version: 'legacy' | 'v0' | 'v1';
  readonly publicKeyHex: string;
  readonly network: string;
  readonly messageHex: string;
  readonly transactionHex: string;
  readonly signerIndex: number;
  readonly signatureOffset: number;
  readonly signable: boolean;
  readonly rows: readonly (readonly [string, string])[];
}
const reviews = new WeakSet<SolanaReview>();
const deadlines = new WeakMap<SolanaReview, number>();

export function decodeSolanaEnvelope(source: string, encoding = 'base64', format = 'transaction') {
  const bytes = decodeSolana(source, encoding);
  let messageBytes: Uint8Array, signatures: Uint8Array[];
  const v1 = bytes[0] === 0x81;
  if (format === 'transaction' && v1) {
    const count = bytes[1]!;
    if (count < 1 || count > 12 || bytes.length < 42 + count * 64) throw new Error('Solana v1 签名数量或长度无效');
    messageBytes = bytes.slice(0, bytes.length - count * 64);
    const reader = new Reader(bytes.slice(messageBytes.length));
    signatures = Array.from({ length: count }, () => reader.take(64));
  } else if (format === 'transaction') {
    const reader = new Reader(bytes);
    const count = reader.short();
    if (count < 1 || count > 19) throw new Error('签名数量无效');
    signatures = Array.from({ length: count }, () => reader.take(64));
    messageBytes = reader.take(bytes.length - reader.offset);
  } else if (format === 'message') {
    messageBytes = bytes;
    signatures = [];
  } else throw new Error('请明确选择 transaction 或 message');
  const message = v1 ? parseV1Message(messageBytes) : parseMessage(messageBytes);
  if (format === 'message') signatures = Array.from({ length: message.signers }, () => new Uint8Array(64));
  if (signatures.length !== message.signers) throw new Error('签名槽数量与 header 不一致');
  const serialized = v1 ? concat(messageBytes, ...signatures) : concat(shortVector(signatures.length), ...signatures, messageBytes);
  const signatureOffset = v1 ? messageBytes.length : shortVector(signatures.length).length;
  if (serialized.length > (v1 ? 4096 : 1232)) throw new Error(v1 ? 'v1 transaction 超出 4096 字节容量' : 'legacy/v0 transaction 超出 1232 字节容量');
  return { message, messageBytes, signatures, serialized, signatureOffset };
}

export function prepareSolanaTransaction(source: string, publicKeyHex: string, network: string,
  encoding = 'base64', format = 'transaction', snapshots = '[]'): SolanaReview {
  if (!['mainnet-beta', 'devnet', 'testnet'].includes(network)) throw new Error('请选择明确的 Solana cluster');
  const publicKey = hexToBytes(publicKeyHex);
  if (publicKey.length !== 32) throw new Error('Solana 需要 Ed25519 公钥');
  const point = ed25519.Point.fromBytes(publicKey, false);
  if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('Ed25519 公钥无效');
  const { message, messageBytes, signatures, serialized, signatureOffset } = decodeSolanaEnvelope(source, encoding, format);
  const resolved = resolveLookups(message, snapshots, network);
  const addresses = [...message.addresses, ...resolved.writable, ...resolved.readonly];
  if (new Set(addresses).size !== addresses.length) throw new Error('消息中存在重复账户地址');
  const staticCount = message.addresses.length;
  const accounts: Account[] = addresses.map((address, index) => ({ address, signer: index < message.signers,
    writable: index < message.signers ? index < message.signers - message.readonlySigners
      : index < staticCount ? index < staticCount - message.readonlyUnsigned : index < staticCount + resolved.writable.length }));
  const rows: [string, string][] = [['版本', message.version], ['所选 cluster（外部上下文）', network],
    ['网络绑定范围', 'Solana 签名不包含 cluster chainId，所选网络用于本次审查上下文'],
    ['Fee payer', addresses[0]!], ['Blockhash / nonce 值', message.blockhash],
    ['消息字节数', String(messageBytes.length)], ['交易字节数', String(serialized.length)],
    ['CanoKey 单次消息限制', '1331 字节（含 Le 的扩展 APDU）']];
  if (message.resources) {
    const config = message.resources;
    rows.push(['v1 配置 mask', `0x${config.mask.toString(16).padStart(8, '0')}`],
      ['v1 Priority fee（总 lamports）', `${config.priorityFee}${config.mask & 3 ? '（显式）' : '（缺省）'}`],
      ['v1 CU limit（请求）', `${config.computeUnitLimit}${config.mask & 4 ? '（显式）' : '（缺省）'}`],
      ['v1 Loaded accounts data limit（字节，请求）', `${config.loadedAccountsDataLimit}${config.mask & 8 ? '（显式）' : '（缺省）'}`],
      ['v1 Heap size（字节）', `${config.heapSize}${config.mask & 16 ? '（显式）' : '（缺省）'}`],
      ['v1 资源规则', '资源配置来自消息头。ComputeBudget 指令为 no-op，Priority fee 是总额。实际资源与费用仍需链上上下文。']);
    if (!config.computeUnitLimit || !config.loadedAccountsDataLimit) rows.push(['v1 资源提示', 'CU 或加载账户数据请求为 0，链上执行可能失败，请核对资源需求。']);
    if (addresses.length > 64) rows.push(['v1 地址容量', '超过 SIMD-0385 的 64 地址基线，执行需要网络启用 SIMD-0596。']);
  }
  for (const [index, account] of accounts.entries()) rows.push([`账户 ${index}`, `${account.address} · ${account.signer ? 'signer' : '非 signer'} · ${account.writable ? '可写' : '只读'}`]);
  signatures.forEach((signature, index) => {
    if (signature.some((byte) => byte !== 0)) {
      if (!ed25519.verify(signature, messageBytes, addressBytes(addresses[index]!), { zip215: false })) throw new Error(`已有签名 ${index} 无效`);
      rows.push([`签名槽 ${index}`, '已有非空签名，独立本地验签通过']);
    } else rows.push([`签名槽 ${index}`, '未签名']);
  });
  for (const source of resolved.sources) rows.push(['ALT 来源与顺序', source]);
  const decoded = reviewInstructions(message.instructions, accounts, message.version);
  rows.push(...decoded.rows);
  rows.push(['费用上下文', '本地展示资源配置；准确 base fee、priority fee 和租金需用户选定 RPC 上下文']);
  const signerIndex = message.addresses.slice(0, message.signers).indexOf(base58.encode(publicKey));
  const fitsDevice = messageBytes.length <= 1331;
  if (!fitsDevice) rows.push(['设备容量策略', `原始消息 ${messageBytes.length} 字节，超过 1331 字节，仅供审查。`]);
  const signable = fitsDevice && signerIndex >= 0 && !signatures[signerIndex]!.some((byte) => byte !== 0) && decoded.understood;
  if (signerIndex < 0) rows.push(['当前账户', '不属于 required signer，当前拒签']);
  if (signerIndex >= 0 && signatures[signerIndex]!.some((byte) => byte !== 0)) rows.push(['当前账户', '已有签名，仅供检查']);
  const review: SolanaReview = Object.freeze({ chain: 'solana', version: message.version, publicKeyHex, network,
    messageHex: bytesToHex(messageBytes), transactionHex: bytesToHex(serialized), signerIndex, signatureOffset, signable,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))) });
  reviews.add(review);
  return review;
}
export function assertSolanaReview(review: SolanaReview): void {
  if (!reviews.has(review) || !review.signable) throw new Error('Solana 审查对象无效或当前策略拒签');
  if (Date.now() >= (deadlines.get(review) ?? Infinity)) throw new Error('审查上下文已过期，请重新读取并审查');
}
export function withSolanaRpcContext(review: SolanaReview, context: {
  transactionHex: string; network: string; expiresAt: number; accepted: boolean; rows: readonly (readonly [string, string])[];
}): SolanaReview {
  const now = Date.now(), previousDeadline = deadlines.get(review) ?? Infinity;
  if (!reviews.has(review) || context.transactionHex !== review.transactionHex || context.network !== review.network
    || !Number.isSafeInteger(context.expiresAt) || context.expiresAt <= now || context.expiresAt > now + 120000) throw new Error('RPC 上下文与交易、网络或有效期不一致');
  if (now >= previousDeadline) throw new Error('审查上下文已过期，请重新读取并审查');
  const rows = review.rows.map(([label, value]) => {
    if (label === 'ALT 来源与顺序') value = value.replace('离线快照，未经链上验证', 'RPC 返回账户数据，未提供独立链上证明');
    if (label === '费用上下文') value = '本次消息网络费见下方 RPC 费用。租金与账户执行效果仍需结合状态核对。';
    return [label, value] as const;
  });
  const result: SolanaReview = Object.freeze({ ...review, signable: review.signable && context.accepted,
    rows: Object.freeze([...rows, ...context.rows].map((row) => Object.freeze([...row] as [string, string]))) });
  reviews.add(result); deadlines.set(result, Math.min(previousDeadline, context.expiresAt));
  return result;
}
export function attachSolanaSignature(review: SolanaReview, signature: Uint8Array): Uint8Array {
  assertSolanaReview(review);
  if (signature.length !== 64 || !ed25519.verify(signature, hexToBytes(review.messageHex), hexToBytes(review.publicKeyHex), { zip215: false })) throw new Error('Ed25519 返回签名无效');
  const original = hexToBytes(review.transactionHex);
  const start = review.signatureOffset + review.signerIndex * 64;
  const result = original.slice();
  result.set(signature, start);
  const message = review.version === 'v1' ? result.slice(0, review.signatureOffset) : result.slice(original.length - review.messageHex.length / 2);
  if (bytesToHex(message) !== review.messageHex) throw new Error('签名附加改变了消息');
  const restored = result.slice(); restored.fill(0, start, start + 64);
  if (bytesToHex(restored) !== review.transactionHex) throw new Error('签名附加改变了其他签名槽');
  return result;
}
