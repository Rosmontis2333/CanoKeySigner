import { Transaction, addr } from 'micro-eth-signer';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { strictJson } from '../../signing/json';
import { attachEvmSignature } from './signature';
import { evmNetworkLabel } from './networks';
import { reviewEvmCalldata } from './calldata';

type EthTransaction = InstanceType<typeof Transaction>;
export interface EvmReview {
  readonly chain: 'evm';
  readonly unsignedHex: string;
  readonly digestHex: string;
  readonly publicKeyHex: string;
  readonly sender: string;
  readonly chainId: string;
  readonly signable: boolean;
  readonly rows: readonly (readonly [string, string])[];
}
const reviews = new WeakSet<EvmReview>();
const deadlines = new WeakMap<EvmReview, number>();
const UINT256_LIMIT = 1n << 256n;
function quantity(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*|0x(?:0|[1-9a-fA-F][0-9a-fA-F]*))$/.test(value)) {
    throw new Error(`${name} 必须是规范的整数字符串`);
  }
  const result = BigInt(value);
  if (result >= UINT256_LIMIT) throw new Error(`${name} 超出 uint256`);
  return result;
}

function fromJson(source: string): EthTransaction {
  const obj = strictJson(source);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('交易 JSON 必须为对象');
  const raw = obj as Record<string, unknown>;
  const type = raw.type === '0x0' || raw.type === '0' ? 'legacy'
    : raw.type === '0x1' || raw.type === '1' ? 'eip2930'
    : raw.type === '0x2' || raw.type === '2' ? 'eip1559' : undefined;
  if (!type) throw new Error('type 必须明确指定为字符串 0、1 或 2');
  const numeric = ['chainId', 'nonce', 'gasLimit', 'value',
    ...(type === 'eip1559' ? ['maxFeePerGas', 'maxPriorityFeePerGas'] : ['gasPrice'])];
  const allowed = new Set(['type', 'to', 'data', ...numeric, ...(type === 'legacy' ? [] : ['accessList'])]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`未知或冲突字段 ${key}`);
  const fields: Record<string, unknown> = {};
  for (const key of numeric) fields[key] = quantity(raw[key], key);
  if (typeof raw.to !== 'string' || (raw.to !== '' && raw.to !== '0x' && !addr.isValid(raw.to))) throw new Error('to 地址无效');
  if (typeof raw.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.data)) throw new Error('data 必须为 0x 开头的完整字节');
  fields.to = raw.to || '0x';
  fields.data = raw.data.slice(2);
  if (type !== 'legacy') {
    if (!Array.isArray(raw.accessList)) throw new Error('必须明确提供 accessList');
    fields.accessList = raw.accessList;
  }
  // The locked library performs the transaction-specific field/size validation.
  return new Transaction(type, fields as never, { strict: false });
}

function decodeTransaction(source: string): EthTransaction {
  if (source.length > 262144) throw new Error('交易输入过大');
  const text = source.trim();
  const transaction = text.startsWith('{') ? fromJson(text) : Transaction.fromHex(text);
  if (!['legacy', 'eip2930', 'eip1559'].includes(transaction.type)) throw new Error('当前支持 EVM type 0/1/2 交易体');
  const raw = transaction.raw;
  if (!raw.chainId || raw.chainId <= 0n) throw new Error('交易缺少有效 chainId 或重放保护');
  if (transaction.fee + raw.value >= UINT256_LIMIT) throw new Error('交易金额与最大网络费合计超出 uint256');
  return transaction;
}

export function evmTransactionChainId(source: string): string {
  return decodeTransaction(source).raw.chainId!.toString();
}

export function prepareEvmTransaction(source: string, publicKeyHex: string, expectedChainId?: string): EvmReview {
  const transaction = decodeTransaction(source), raw = transaction.raw;
  const chainId = raw.chainId!;
  if (expectedChainId !== undefined && chainId !== quantity(expectedChainId, '会话 chainId')) throw new Error('交易 chainId 与会话不一致');
  const unsignedHex = transaction.toHex({ includeSignature: false });
  const sender = transaction.isSigned ? transaction.sender : addr.fromPublicKey(hexToBytes(publicKeyHex));
  const rows: [string, string][] = [
    ['类型', transaction.type], ['网络（来自交易）', evmNetworkLabel(chainId.toString())], ['chainId', chainId.toString()], ['签名账户', sender],
    ['收款 / 合约地址', raw.to === '0x' ? '创建合约' : raw.to], ['value（wei）', raw.value.toString()],
    ['nonce', raw.nonce.toString()], ['gasLimit', raw.gasLimit.toString()],
  ];
  rows.push(['最大网络费（wei）', transaction.fee.toString()]);
  if ('gasPrice' in raw) rows.push(['gasPrice（wei）', raw.gasPrice.toString()]);
  else rows.push(['maxFeePerGas（wei）', raw.maxFeePerGas.toString()], ['maxPriorityFeePerGas（wei）', raw.maxPriorityFeePerGas.toString()]);
  if ('accessList' in raw) rows.push(['Access list', JSON.stringify(raw.accessList)]);
  const data = raw.data.replace(/^0x/, '').toLowerCase();
  rows.push(['原始 calldata', `0x${data}`]);
  let understood = data === '' && raw.to !== '0x' && raw.to !== '';
  if (data && raw.to !== '0x' && raw.to !== '') {
    const call = reviewEvmCalldata(data, raw.value);
    rows.push(...call.rows);
    understood = call.understood;
  }
  const signable = understood && !transaction.isSigned;
  if (!understood) rows.push(['签名策略', '合约创建、未知调用或参数未满足审查规则，当前拒签']);
  if (transaction.isSigned) {
    if (!transaction.verifySignature()) throw new Error('已有交易签名无效');
    rows.push(['已有签名', '验签通过，仅供检查']);
  }
  const review: EvmReview = Object.freeze({ chain: 'evm', unsignedHex,
    digestHex: bytesToHex(keccak_256(transaction.toBytes({ includeSignature: false }))),
    publicKeyHex, sender, chainId: chainId.toString(), signable,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
  reviews.add(review);
  return review;
}

export function assertEvmReview(review: EvmReview): void {
  if (!reviews.has(review) || !review.signable) throw new Error('交易审查对象无效或当前策略拒签');
  if (Date.now() >= (deadlines.get(review) ?? Infinity)) throw new Error('EVM RPC 审查上下文已过期，请重新读取并审查');
}

export function withEvmRpcContext(review: EvmReview, context: {
  unsignedHex: string; chainId: string; expiresAt: number; accepted: boolean; rows: readonly (readonly [string, string])[];
}): EvmReview {
  const now = Date.now(), previousDeadline = deadlines.get(review) ?? Infinity;
  if (!reviews.has(review) || context.unsignedHex !== review.unsignedHex || context.chainId !== review.chainId
    || !Number.isSafeInteger(context.expiresAt) || context.expiresAt <= now || context.expiresAt > now + 120000) throw new Error('RPC 上下文与 EVM 交易、链或有效期不一致');
  if (now >= previousDeadline) throw new Error('EVM RPC 审查上下文已过期，请重新读取并审查');
  const result = Object.freeze({ ...review, signable: review.signable && context.accepted,
    rows: Object.freeze([...review.rows, ...context.rows].map((row) => Object.freeze([...row] as [string, string]))) });
  reviews.add(result); deadlines.set(result, Math.min(previousDeadline, context.expiresAt)); return result;
}

export function attachEvmTransaction(review: EvmReview, signature: Uint8Array): string {
  assertEvmReview(review);
  const transaction = Transaction.fromHex(review.unsignedHex);
  const body = attachEvmSignature(transaction, hexToBytes(review.digestHex), signature, hexToBytes(review.publicKeyHex)).toHex();
  return body;
}
