import { Transaction, addr } from 'micro-eth-signer';
import { hexToBytes } from '@noble/hashes/utils.js';
import { prepareEvmTransaction, withEvmRpcContext } from '../chains/evm/transaction';
import { createRpcClient, rpcObject, RpcResponseError } from './rpc';
import { validateEvmRpcEndpoint } from './config';
import type { EvmRpcEndpoint } from './config';
import { strictJson } from '../signing/json';

export function evmRpcQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) throw new Error('EVM RPC quantity 编码无效或超出 uint256');
  return BigInt(value);
}
const quantity = (value: bigint | number) => `0x${value.toString(16)}`;
function data(value: unknown, limit = 16384): string {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || value.length > 2 + limit * 2) throw new Error('EVM RPC 返回字节格式或长度无效');
  return value.toLowerCase();
}
function block(value: unknown) {
  const raw = rpcObject(value), number = evmRpcQuantity(raw.number), hash = data(raw.hash, 32);
  if (hash.length !== 66) throw new Error('EVM RPC block hash 长度无效');
  return { number, hash, timestamp: evmRpcQuantity(raw.timestamp), gasLimit: evmRpcQuantity(raw.gasLimit),
    baseFee: raw.baseFeePerGas === undefined ? undefined : evmRpcQuantity(raw.baseFeePerGas) };
}

function transactionCall(transaction: InstanceType<typeof Transaction>, sender: string): Record<string, unknown> {
  const raw = transaction.raw;
  const types = { legacy: 0, eip2930: 1, eip1559: 2 };
  const call: Record<string, unknown> = { type: quantity(types[transaction.type as keyof typeof types]), from: sender, to: raw.to, chainId: quantity(raw.chainId!), nonce: quantity(raw.nonce),
    gas: quantity(raw.gasLimit), value: quantity(raw.value), data: raw.data.startsWith('0x') ? raw.data : `0x${raw.data}` };
  if (raw.to === '0x') delete call.to;
  if ('gasPrice' in raw) call.gasPrice = quantity(raw.gasPrice);
  else { call.maxFeePerGas = quantity(raw.maxFeePerGas); call.maxPriorityFeePerGas = quantity(raw.maxPriorityFeePerGas); }
  if ('accessList' in raw) call.accessList = raw.accessList;
  return call;
}

export async function readEvmSendContext(endpoint: EvmRpcEndpoint, input: {
  source: string; publicKeyHex: string; chainId: string;
}, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  input = Object.freeze({ ...input });
  const startedAt = Date.now(), selected = validateEvmRpcEndpoint(endpoint);
  if (selected.chainId !== input.chainId) throw new Error('RPC 来源与请求 chainId 不一致');
  const original = rpcObject(strictJson(input.source)), resolved = { ...original };
  const suppliedType = resolved.type;
  if (suppliedType !== undefined && !['0', '0x0', '1', '0x1', '2', '0x2'].includes(String(suppliedType))) throw new Error('交易 type 无效');
  const rpc = createRpcClient(selected, fetcher);
  if (evmRpcQuantity(await rpc.call('eth_chainId', [], signal)) !== BigInt(input.chainId)) throw new Error('RPC chainId 与请求不一致');
  const head = block(await rpc.call('eth_getBlockByNumber', ['latest', false], signal));
  const additions: [string, string][] = [];
  function fill(name: string, value: unknown, source: string): void {
    if (resolved[name] !== undefined) return;
    resolved[name] = value; additions.push([`请求补全 ${name}`, `${JSON.stringify(value)} · ${source}`]);
  }
  let inferredType = head.baseFee === undefined ? (resolved.accessList === undefined ? '0' : '1') : '2';
  if (resolved.maxFeePerGas !== undefined || resolved.maxPriorityFeePerGas !== undefined) inferredType = '2';
  else if (resolved.gasPrice !== undefined) inferredType = resolved.accessList === undefined ? '0' : '1';
  fill('type', inferredType, '根据请求费用字段及参考区块推断');
  fill('chainId', input.chainId, 'WalletConnect 本次请求已授权的 chainId');
  fill('to', '0x', '请求省略收款地址，按合约创建审查');
  fill('value', '0', '请求未指定 value'); fill('data', '0x', '请求未指定调用数据');
  const legacy = resolved.type === '0' || resolved.type === '0x0' || resolved.type === '1' || resolved.type === '0x1';
  if (resolved.type !== '0' && resolved.type !== '0x0') fill('accessList', [], '请求未指定 accessList');
  if (resolved.nonce === undefined) fill('nonce', String(evmRpcQuantity(await rpc.call('eth_getTransactionCount', [addr.fromPublicKey(hexToBytes(input.publicKeyHex)), 'pending'], signal))), 'RPC pending nonce');
  if (legacy) {
    if (resolved.gasPrice === undefined) fill('gasPrice', String(evmRpcQuantity(await rpc.call('eth_gasPrice', [], signal))), 'RPC gasPrice');
  } else {
    if (resolved.maxPriorityFeePerGas === undefined) fill('maxPriorityFeePerGas', String(evmRpcQuantity(await rpc.call('eth_maxPriorityFeePerGas', [], signal))), 'RPC priority fee 建议');
    if (resolved.maxFeePerGas === undefined) {
      if (head.baseFee === undefined) throw new Error('当前区块缺少 baseFee，无法补全动态费用上限');
      const priority = resolved.maxPriorityFeePerGas;
      if (typeof priority !== 'string' || !/^(0|[1-9][0-9]*|0x(?:0|[1-9a-fA-F][0-9a-fA-F]*))$/.test(priority)) throw new Error('maxPriorityFeePerGas 编码无效');
      fill('maxFeePerGas', String(head.baseFee * 2n + BigInt(priority)), '参考区块 baseFee × 2 + priority fee');
    }
  }
  const provisional = prepareEvmTransaction(JSON.stringify({ ...resolved, gasLimit: resolved.gasLimit ?? '30000000' }), input.publicKeyHex, input.chainId);
  if (!provisional.signable) throw new Error('提交请求不满足交易审查策略');
  if (resolved.gasLimit === undefined) {
    const call = transactionCall(Transaction.fromHex(provisional.unsignedHex), provisional.sender); delete call.gas;
    fill('gasLimit', String(evmRpcQuantity(await rpc.call('eth_estimateGas', [call, 'pending'], signal))), 'RPC pending gas 估计，直接使用估计值');
  }
  const result = await readEvmRpcContext(selected, { source: JSON.stringify(resolved), publicKeyHex: input.publicKeyHex }, signal, fetcher);
  const expiresAt = Math.min(result.expiresAt, startedAt + 120000);
  const rows: [string, string][] = [['提交请求原始字段（规范化后）', input.source],
    ['请求补全参考区块', `${head.number} · ${head.hash} · baseFee ${head.baseFee === undefined ? '未返回' : String(head.baseFee)} wei/gas`], ...additions,
    ['提交请求补全范围', '保留 dApp 已提供字段。补全结果已固定，须重新核对全部金额与网络费后批准签名及提交。'],
    ['提交请求有效期', `${new Date(expiresAt).toISOString()}，取字段补全与执行检查的较早期限`]];
  return { review: withEvmRpcContext(result.review, { unsignedHex: result.review.unsignedHex, chainId: input.chainId, expiresAt, accepted: true, rows }), expiresAt };
}

export async function readEvmRpcContext(endpoint: EvmRpcEndpoint, input: {
  source: string; publicKeyHex: string;
}, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  input = Object.freeze({ ...input });
  const selected = validateEvmRpcEndpoint(endpoint), startedAt = Date.now();
  const base = prepareEvmTransaction(input.source, input.publicKeyHex);
  if (selected.chainId !== base.chainId) throw new Error('RPC 配置 chainId 与交易内容不一致');
  const transaction = Transaction.fromHex(base.unsignedHex), raw = transaction.raw;
  const rpc = createRpcClient(selected, fetcher);
  if (evmRpcQuantity(await rpc.call('eth_chainId', [], signal)) !== raw.chainId) throw new Error('RPC chainId 与交易内容不一致');
  const head = block(await rpc.call('eth_getBlockByNumber', ['latest', false], signal)), tag = quantity(head.number);
  const nonce = evmRpcQuantity(await rpc.call('eth_getTransactionCount', [base.sender, tag], signal));
  const pendingNonce = evmRpcQuantity(await rpc.call('eth_getTransactionCount', [base.sender, 'pending'], signal));
  const balance = evmRpcQuantity(await rpc.call('eth_getBalance', [base.sender, tag], signal));
  const targetCode = raw.to === '0x' ? undefined : data(await rpc.call('eth_getCode', [raw.to, tag], signal), 49152);
  const call = transactionCall(transaction, base.sender);
  let accepted = true;
  const rows: [string, string][] = [['RPC 来源（用户选择）', `${selected.name} · ${new URL(selected.url).origin}`],
    ['RPC chainId 核对', base.chainId], ['RPC 参考区块', `${head.number} · ${head.hash}`], ['RPC 区块时间戳（秒）', String(head.timestamp)],
    ['RPC 信任范围', '数据依赖所选端点，未提供独立链上证明。执行检查按同一区块号读取并在结束时复核区块 hash。'],
    ['RPC 账户 nonce（参考区块）', String(nonce)], ['RPC 账户 nonce（pending）', String(pendingNonce)],
    ['RPC 账户余额（wei）', String(balance)], ['RPC 金额与最大网络费需求（wei）', String(raw.value + transaction.fee)],
    ['RPC 目标代码', targetCode === undefined ? '合约创建' : targetCode === '0x' ? '参考区块未返回代码' : `${(targetCode.length - 2) / 2} 字节，代码行为需核对`]];
  const refuse = (message: string) => { accepted = false; rows.push(['RPC 签名策略', message]); };
  if (pendingNonce < nonce) throw new Error('RPC pending nonce 早于参考区块 nonce');
  if (raw.nonce !== pendingNonce) refuse('交易 nonce 与当前 pending nonce 不一致，请核对待处理交易后重新导入。');
  if (balance < raw.value + transaction.fee) refuse('参考区块余额不足以覆盖金额与最大网络费。');
  if (raw.gasLimit > head.gasLimit) refuse('交易 gasLimit 超过参考区块 gasLimit。');
  const price = 'gasPrice' in raw ? raw.gasPrice : raw.maxFeePerGas;
  rows.push(['RPC 区块 gasLimit', String(head.gasLimit)], ['RPC 区块 baseFee（wei/gas）', head.baseFee === undefined ? '端点未返回' : String(head.baseFee)]);
  if (head.baseFee !== undefined && price < head.baseFee) refuse('交易每 gas 费用上限低于参考区块 baseFee。');
  try {
    const output = data(await rpc.call('eth_call', [call, tag], signal));
    rows.push(['RPC eth_call 结果', output], ['RPC eth_call 状态', '参考区块执行成功']);
  } catch (error) {
    if (!(error instanceof RpcResponseError)) throw error;
    refuse(`eth_call 失败，RPC 错误码 ${error.code}。`);
  }
  try {
    const gas = evmRpcQuantity(await rpc.call('eth_estimateGas', [call, tag], signal));
    if (!gas) throw new Error('RPC gas 估计为 0');
    rows.push(['RPC gas 估计', String(gas)]);
    if (gas > raw.gasLimit) refuse('RPC gas 估计超过交易指定 gasLimit。');
  } catch (error) {
    if (!(error instanceof RpcResponseError)) throw error;
    refuse(`eth_estimateGas 失败，RPC 错误码 ${error.code}。`);
  }
  const final = block(await rpc.call('eth_getBlockByNumber', [tag, false], signal));
  if (final.number !== head.number || final.hash !== head.hash) throw new Error('RPC 参考区块发生变化，请重新读取并审查');
  if (evmRpcQuantity(await rpc.call('eth_chainId', [], signal)) !== raw.chainId) throw new Error('RPC chainId 在读取期间发生变化');
  signal.throwIfAborted();
  const expiresAt = startedAt + 120000;
  rows.push(['RPC 执行检查范围', '使用原交易的账户、金额、calldata、gas 和费用字段，无状态覆盖。eth_call 不校验外层签名，未来执行与 pending 状态仍可能变化。'],
    ['RPC 上下文有效期', `${new Date(expiresAt).toISOString()}，内容或来源变化后需重新确认`]);
  return { review: withEvmRpcContext(base, { unsignedHex: base.unsignedHex, chainId: base.chainId, expiresAt, accepted, rows }), expiresAt };
}
