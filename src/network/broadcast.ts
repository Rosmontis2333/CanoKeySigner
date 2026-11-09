import { Transaction } from 'micro-eth-signer';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { assertEvmReview } from '../chains/evm/transaction';
import type { EvmReview } from '../chains/evm/transaction';
import { assertSolanaReview, attachSolanaSignature, decodeSolanaEnvelope } from '../chains/solana/transaction';
import type { SolanaReview } from '../chains/solana/transaction';
import { addressBytes } from '../chains/solana/codec';
import { validateEvmRpcEndpoint, validateRpcEndpoint, SOLANA_GENESIS } from './config';
import type { EvmRpcEndpoint, SolanaRpcEndpoint } from './config';
import { createRpcClient, createSubmissionClient, rpcContext, rpcInteger, rpcObject } from './rpc';
import { evmRpcQuantity, readEvmRpcContext } from './evm';
import { readSolanaRpcContext } from './solana';
import { solanaSendOptions } from '../chains/solana/send-options';
import type { SolanaSendOptions } from '../chains/solana/send-options';

export interface BroadcastTask {
  readonly chain: 'evm' | 'solana';
  readonly network: string;
  readonly id: string;
  readonly source: string;
  readonly rows: readonly (readonly [string, string])[];
}
export interface BroadcastResult {
  readonly state: 'accepted' | 'pending' | 'confirmed' | 'failed' | 'unknown' | 'not-sent';
  readonly message: string;
}
interface Prepared {
  endpoint: EvmRpcEndpoint | SolanaRpcEndpoint;
  original: EvmReview | SolanaReview;
  signed: string;
  expiresAt: number;
  attempted: boolean;
  solanaOptions?: SolanaSendOptions;
}
const tasks = new WeakMap<BroadcastTask, Prepared>();
// One write attempt per network and transaction ID for this page lifetime, across RPC sources.
const submitted = new Set<string>();
export function prepareBroadcast(review: EvmReview | SolanaReview, output: string, endpoint: EvmRpcEndpoint | SolanaRpcEndpoint, sendOptions?: unknown): BroadcastTask {
  let selected: EvmRpcEndpoint | SolanaRpcEndpoint, signed: string, id: string, network: string;
  if (review.chain === 'evm') {
    if (sendOptions !== undefined) throw new Error('EVM 提交不接受 Solana sendOptions');
    assertEvmReview(review);
    selected = validateEvmRpcEndpoint(endpoint); network = review.chainId;
    if (selected.chainId !== network) throw new Error('广播 RPC 与交易 chainId 不一致');
    if (output.length > 262144) throw new Error('签名交易过大');
    const transaction = Transaction.fromHex(output);
    if (!transaction.isSigned || !transaction.verifySignature() || transaction.sender !== review.sender
      || transaction.toHex({ includeSignature: false }) !== review.unsignedHex) throw new Error('广播交易与已批准交易或签名账户不一致');
    signed = transaction.toHex();
    id = `0x${bytesToHex(keccak_256(transaction.toBytes()))}`;
  } else {
    assertSolanaReview(review);
    selected = validateRpcEndpoint(endpoint); network = review.network;
    if (selected.network !== network) throw new Error('广播 RPC 与 Solana cluster 不一致');
    const envelope = decodeSolanaEnvelope(output);
    if (bytesToHex(envelope.messageBytes) !== review.messageHex) throw new Error('广播消息与已批准原始消息不一致');
    if (bytesToHex(attachSolanaSignature(review, envelope.signatures[review.signerIndex]!)) !== bytesToHex(envelope.serialized)) throw new Error('广播交易改变了其他签名槽');
    envelope.signatures.forEach((signature, index) => {
      if (!ed25519.verify(signature, envelope.messageBytes, addressBytes(envelope.message.addresses[index]!), { zip215: false })) throw new Error(`签名槽 ${index} 尚未完成有效签名，请先收集全部协签`);
    });
    signed = base64.encode(envelope.serialized); id = base58.encode(envelope.signatures[0]!);
  }
  const source = `${selected.name} · ${new URL(selected.url).origin}`;
  const options = review.chain === 'solana' ? solanaSendOptions(sendOptions) : undefined;
  const rows: [string, string][] = [...review.rows.map(([label, value]) => [label, value] as [string, string]), ['广播网络', network], ['提交来源', source], ['本地计算交易标识', id],
    ['提交内容', '当前已验证的签名交易，字段与签名保持精确原值。'],
    ['提交策略', '确认后先查询状态并重新检查上下文。每个交易标识最多尝试提交一次，提交后可单独查询状态。'],
    ['结果范围', '节点接受表示接收了交易，后续入块与执行状态以查询结果为准。超时或取消后结果可能不确定。']];
  if (options) rows.push(['提交 sendOptions', JSON.stringify(options)], ['节点重传范围', 'maxRetries 仅控制节点重传同一份签名交易。应用按同一交易标识最多发起一次提交。']);
  const task = Object.freeze({ chain: review.chain, network, id, source, rows: Object.freeze(rows.map((row) => Object.freeze(row))) });
  tasks.set(task, { endpoint: selected, original: review, signed, expiresAt: Date.now() + 120000, attempted: false,
    ...(options ? { solanaOptions: options } : {}) });
  return task;
}
function prepared(task: BroadcastTask): Prepared {
  const result = tasks.get(task);
  if (!result) throw new Error('广播审查对象无效');
  return result;
}
async function verifyNetwork(task: BroadcastTask, captured: Prepared, signal: AbortSignal, fetcher: typeof fetch): Promise<void> {
  const rpc = createRpcClient(captured.endpoint, fetcher);
  if (task.chain === 'evm') {
    if (evmRpcQuantity(await rpc.call('eth_chainId', [], signal)) !== BigInt(task.network)) throw new Error('RPC chainId 与广播网络不一致');
  } else if (await rpc.call('getGenesisHash', [], signal) !== SOLANA_GENESIS[task.network]) throw new Error('RPC genesis 与广播 cluster 不一致');
}
async function status(task: BroadcastTask, captured: Prepared, signal: AbortSignal, fetcher: typeof fetch): Promise<BroadcastResult> {
  const rpc = createRpcClient(captured.endpoint, fetcher);
  if (task.chain === 'evm') {
    const receipt = await rpc.call('eth_getTransactionReceipt', [task.id], signal);
    if (receipt !== null) {
      const value = rpcObject(receipt);
      if (typeof value.transactionHash !== 'string' || value.transactionHash.toLowerCase() !== task.id
        || typeof value.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash)) throw new Error('RPC receipt 标识无效');
      const execution = evmRpcQuantity(value.status), number = evmRpcQuantity(value.blockNumber);
      if (execution !== 0n && execution !== 1n) throw new Error('RPC receipt 执行状态无效');
      return { state: execution === 1n ? 'confirmed' : 'failed', message: `端点报告已入区块 ${number}，${execution === 1n ? '执行成功' : '执行失败'}。区块最终性仍需后续确认。` };
    }
    const transaction = await rpc.call('eth_getTransactionByHash', [task.id], signal);
    if (transaction !== null) {
      const value = rpcObject(transaction);
      if (typeof value.hash !== 'string' || value.hash.toLowerCase() !== task.id) throw new Error('RPC 返回了不同的交易标识');
      return { state: 'pending', message: '端点已查询到交易，尚未取得有效入块执行回执。' };
    }
  } else {
    const response = rpcContext(await rpc.call('getSignatureStatuses', [[task.id], { searchTransactionHistory: true }], signal), captured.solanaOptions?.minContextSlot ?? 0);
    if (!Array.isArray(response.value) || response.value.length !== 1) throw new Error('RPC 交易状态数量无效');
    if (response.value[0] !== null) {
      const value = rpcObject(response.value[0]), slot = rpcInteger(value.slot);
      if (slot > response.slot || !['processed', 'confirmed', 'finalized'].includes(String(value.confirmationStatus)) || !Object.hasOwn(value, 'err')) throw new Error('RPC 交易确认状态无效');
      if (value.err !== null && typeof value.err !== 'string' && (!value.err || typeof value.err !== 'object' || Array.isArray(value.err))) throw new Error('RPC 交易错误状态格式无效');
      if (value.err !== null) return { state: 'failed', message: `端点报告交易执行失败，slot ${slot}，确认级别 ${String(value.confirmationStatus)}。` };
      return { state: value.confirmationStatus === 'processed' ? 'pending' : 'confirmed',
        message: `端点报告交易执行成功，slot ${slot}，确认级别 ${String(value.confirmationStatus)}。` };
    }
  }
  return { state: 'unknown', message: '端点暂未查询到交易。未查询到记录不能证明提交失败，可稍后再次查询。' };
}
export async function queryBroadcast(task: BroadcastTask, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<BroadcastResult> {
  const captured = prepared(task);
  await verifyNetwork(task, captured, signal, fetcher);
  return status(task, captured, signal, fetcher);
}
export async function submitBroadcast(task: BroadcastTask, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<BroadcastResult> {
  const captured = prepared(task), key = `${task.chain}:${task.network}:${task.id}`;
  if (captured.attempted || submitted.has(key)) throw new Error('此交易已尝试提交，请使用状态查询');
  if (Date.now() >= captured.expiresAt) throw new Error('广播审查已过期，请重新准备');
  signal.throwIfAborted(); captured.attempted = true;
  let writing = false;
  try {
    await verifyNetwork(task, captured, signal, fetcher);
    const existing = await status(task, captured, signal, fetcher);
    if (existing.state !== 'unknown') return existing;
    const review = captured.original;
    const fresh = review.chain === 'evm' && 'chainId' in captured.endpoint
      ? await readEvmRpcContext(captured.endpoint, { source: review.unsignedHex, publicKeyHex: review.publicKeyHex }, signal, fetcher)
      : review.chain === 'solana' && 'network' in captured.endpoint
        ? await readSolanaRpcContext(captured.endpoint, { source: base64.encode(hexToBytes(review.transactionHex)), publicKeyHex: review.publicKeyHex,
          network: review.network, encoding: 'base64', format: 'transaction', commitment: captured.solanaOptions!.preflightCommitment,
          minContextSlot: captured.solanaOptions!.minContextSlot ?? 0 }, signal, fetcher) : undefined;
    if (!fresh?.review.signable) return { state: 'not-sent', message: '提交前的 RPC 费用、账户或执行检查未通过，尚未发送签名交易。' };
    await verifyNetwork(task, captured, signal, fetcher);
    if (Date.now() >= captured.expiresAt) throw new Error('广播审查已过期');
    signal.throwIfAborted();
    if (submitted.has(key)) throw new Error('此交易已在另一任务中尝试提交');
    if (submitted.size >= 1024) throw new Error('本页广播记录已达到上限');
    submitted.add(key); writing = true;
    const rpc = createSubmissionClient(captured.endpoint, fetcher);
    const returned = task.chain === 'evm' ? await rpc.call('eth_sendRawTransaction', [captured.signed], signal)
      : await rpc.call('sendTransaction', [captured.signed, { encoding: 'base64', ...captured.solanaOptions }], signal);
    if (typeof returned !== 'string' || (task.chain === 'evm' ? returned.toLowerCase() : returned) !== task.id) throw new Error('RPC 接受响应与本地交易标识不一致');
    return { state: 'accepted', message: '节点已接受当前交易，等待入块。请查询后续执行状态。' };
  } catch (error) {
    if (!writing) return { state: 'not-sent', message: `签名交易尚未提交。${error instanceof Error ? error.message : '提交前检查失败'}` };
    if (!signal.aborted) {
      try {
        const recovered = await queryBroadcast(task, signal, fetcher);
        if (recovered.state !== 'unknown') return recovered;
      } catch { /* A failed status lookup leaves the write outcome uncertain. */ }
    }
    return { state: 'unknown', message: '已尝试发送交易，响应未能核实。提交结果不确定，请保留交易标识并查询状态。' };
  }
}
