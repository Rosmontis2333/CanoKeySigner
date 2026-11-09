import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decodeSolanaEnvelope, prepareSolanaTransaction, withSolanaRpcContext } from '../chains/solana/transaction';
import { createRpcClient, rpcContext, rpcInteger, rpcObject } from './rpc';
import { SOLANA_GENESIS, validateRpcEndpoint } from './config';
import type { SolanaRpcEndpoint } from './config';
import { solanaSendOptions } from '../chains/solana/send-options';
import type { SolanaSendOptions } from '../chains/solana/send-options';

function readable(value: unknown): string {
  return JSON.stringify(value).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function readSolanaRpcContext(endpoint: SolanaRpcEndpoint, input: {
  source: string; publicKeyHex: string; network: string; encoding: string; format: string;
  commitment?: SolanaSendOptions['preflightCommitment']; minContextSlot?: number;
}, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  input = Object.freeze({ ...input });
  const selected = validateRpcEndpoint(endpoint), startedAt = Date.now();
  if (selected.network !== input.network) throw new Error('RPC 配置与所选 Solana cluster 不一致');
  const envelope = decodeSolanaEnvelope(input.source, input.encoding, input.format);
  const rpc = createRpcClient(selected, fetcher);
  const genesis = await rpc.call('getGenesisHash', [], signal);
  if (genesis !== SOLANA_GENESIS[input.network]) throw new Error('RPC genesis hash 与所选 cluster 不一致');
  const origin = new URL(selected.url).origin;
  const options = solanaSendOptions({ preflightCommitment: input.commitment, minContextSlot: input.minContextSlot });
  const commitment = options.preflightCommitment;
  const snapshots: { address: string; owner: string; dataBase64: string; source: string; contextSlot: string; network: string }[] = [];
  let minSlot = options.minContextSlot ?? 0;
  if (envelope.message.lookups.length) {
    const keys = envelope.message.lookups.map((lookup) => lookup.address);
    const response = rpcContext(await rpc.call('getMultipleAccounts', [keys, { encoding: 'base64', commitment, ...(minSlot ? { minContextSlot: minSlot } : {}) }], signal), minSlot);
    minSlot = response.slot;
    if (!Array.isArray(response.value) || response.value.length !== keys.length) throw new Error('RPC ALT 账户数量或顺序无效');
    response.value.forEach((value, index) => {
      const account = rpcObject(value);
      if (account.executable !== false || typeof account.owner !== 'string' || !Array.isArray(account.data)
        || account.data.length !== 2 || typeof account.data[0] !== 'string' || account.data[1] !== 'base64') throw new Error('RPC ALT 账户数据无效');
      snapshots.push({ address: keys[index]!, owner: account.owner, dataBase64: account.data[0], source: `${selected.name} · ${origin}`,
        contextSlot: String(minSlot), network: input.network });
    });
  }
  const base = prepareSolanaTransaction(input.source, input.publicKeyHex, input.network, input.encoding, input.format, JSON.stringify(snapshots));
  const fee = rpcContext(await rpc.call('getFeeForMessage', [base64.encode(envelope.messageBytes), { commitment, minContextSlot: minSlot }], signal), minSlot);
  const lamports = fee.value === null ? null : rpcInteger(fee.value);
  const simulation = rpcContext(await rpc.call('simulateTransaction', [base64.encode(envelope.serialized), {
    encoding: 'base64', commitment, minContextSlot: fee.slot, sigVerify: false, replaceRecentBlockhash: false,
  }], signal), fee.slot);
  const value = rpcObject(simulation.value);
  if (!Object.hasOwn(value, 'err') || (value.err !== null && typeof value.err !== 'string' && (typeof value.err !== 'object' || Array.isArray(value.err)))) throw new Error('RPC 模拟错误字段无效');
  const errorText = readable(value.err);
  if (errorText.length > 8192) throw new Error('RPC 模拟错误内容过大');
  const units = value.unitsConsumed == null ? undefined : rpcInteger(value.unitsConsumed);
  const logs = value.logs ?? [];
  if (!Array.isArray(logs) || logs.length > 128 || logs.some((log) => typeof log !== 'string' || log.length > 4096)) throw new Error('RPC 模拟日志超出显示上限或格式无效');
  signal.throwIfAborted();
  const expiresAt = startedAt + 120000;
  const rows: [string, string][] = [['RPC 来源（用户选择）', `${selected.name} · ${origin}`], ['RPC cluster 核对', `${input.network} · genesis ${String(genesis)}`],
    ['RPC 信任范围', '通过所选端点返回的数据核对网络与状态，尚无独立链上证明。'],
    ['RPC commitment', commitment], ['RPC 上下文 slots', `ALT / 最小上下文 ${minSlot || '无'} · 费用 ${fee.slot} · 模拟 ${simulation.slot}`],
    ['RPC 费用（lamports）', lamports === null ? '未返回有效费用，blockhash 或上下文可能已失效' : String(lamports)],
    ['RPC 模拟结果', value.err === null ? '模拟成功' : `模拟失败 ${errorText}`], ['RPC 模拟消耗 CU', units === undefined ? '端点未返回' : String(units)],
    ['RPC 模拟范围', '按原始消息与 blockhash 模拟，未验证交易签名。模拟是补充证据，实际执行结果仍可能变化。'],
    ['RPC 上下文有效期', `${new Date(expiresAt).toISOString()}，重新读取或内容变化后需重新确认`]];
  logs.forEach((log, index) => rows.push([`RPC 模拟日志 ${index}`, readable(log)]));
  return { review: withSolanaRpcContext(base, { transactionHex: bytesToHex(envelope.serialized), network: input.network,
    expiresAt, accepted: lamports !== null && value.err === null, rows }), expiresAt };
}
