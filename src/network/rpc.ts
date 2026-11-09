import { strictJson } from '../signing/json';
import { rpcUrl } from './config';

type Method = 'getGenesisHash' | 'getMultipleAccounts' | 'getFeeForMessage' | 'simulateTransaction' | 'getLatestBlockhash'
  | 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getTransactionCount' | 'eth_getBalance' | 'eth_getCode' | 'eth_call' | 'eth_estimateGas'
  | 'eth_getTransactionReceipt' | 'eth_getTransactionByHash' | 'getSignatureStatuses' | 'eth_gasPrice' | 'eth_maxPriorityFeePerGas';
type SubmissionMethod = 'eth_sendRawTransaction' | 'sendTransaction';
const methods: readonly string[] = ['getGenesisHash', 'getMultipleAccounts', 'getFeeForMessage', 'simulateTransaction', 'getLatestBlockhash',
  'eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getBalance', 'eth_getCode', 'eth_call', 'eth_estimateGas',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'getSignatureStatuses', 'eth_gasPrice', 'eth_maxPriorityFeePerGas'];
export class RpcResponseError extends Error {
  constructor(readonly method: Method | SubmissionMethod, readonly code: number) { super(`RPC ${method} 返回错误 ${code}`); }
}
let sequence = 0;
const RESPONSE_LIMIT = 1048576;
export function rpcObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RPC 返回对象格式无效');
  return value as Record<string, unknown>;
}
export function rpcInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('RPC 返回整数越界或精度不可靠');
  return value;
}
export function rpcContext(value: unknown, minSlot = 0): { slot: number; value: unknown } {
  const result = rpcObject(value), slot = rpcInteger(rpcObject(result.context).slot);
  if (slot < minSlot || !Object.hasOwn(result, 'value')) throw new Error('RPC 上下文 slot 过旧或缺少 value');
  return { slot, value: result.value };
}

export function createRpcClient(endpoint: { readonly url: string }, fetcher: typeof fetch = fetch) {
  return createClient<Method>(endpoint, fetcher, methods);
}
export function createSubmissionClient(endpoint: { readonly url: string }, fetcher: typeof fetch = fetch) {
  return createClient<SubmissionMethod>(endpoint, fetcher, ['eth_sendRawTransaction', 'sendTransaction']);
}
function createClient<M extends Method | SubmissionMethod>(endpoint: { readonly url: string }, fetcher: typeof fetch, allowed: readonly string[]) {
  const selectedUrl = rpcUrl(endpoint.url);
  return { async call(method: M, params: unknown[], signal: AbortSignal): Promise<unknown> {
    if (!allowed.includes(method)) throw new Error('此 RPC 入口不允许该方法');
    signal.throwIfAborted();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 15000);
    const id = ++sequence;
    try {
      const response = await fetcher(selectedUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), credentials: 'omit', redirect: 'error',
        cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal });
      abort.signal.throwIfAborted();
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error(`RPC HTTP ${response.status}`); }
      const declared = response.headers.get('Content-Length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('RPC 响应超过 1 MiB');
      }
      if (!response.body) throw new Error('RPC 响应为空');
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      const chunks: string[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          abort.signal.throwIfAborted();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > RESPONSE_LIMIT) throw new Error('RPC 响应超过 1 MiB');
          chunks.push(decoder.decode(chunk.value, { stream: true }));
        }
        chunks.push(decoder.decode());
      } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const envelope = rpcObject(strictJson(chunks.join(''), RESPONSE_LIMIT));
      if (envelope.jsonrpc !== '2.0' || envelope.id !== id || Object.hasOwn(envelope, 'result') === Object.hasOwn(envelope, 'error')) throw new Error('RPC 响应 ID 或 JSON-RPC 格式无效');
      if (Object.hasOwn(envelope, 'error')) {
        const error = rpcObject(envelope.error);
        if (typeof error.code !== 'number' || !Number.isSafeInteger(error.code)) throw new Error('RPC 错误响应格式无效');
        throw new RpcResponseError(method, error.code);
      }
      return envelope.result;
    } catch (error) {
      if (abort.signal.aborted || signal.aborted) throw new Error('RPC 读取已取消或超时');
      if (error instanceof TypeError) throw new Error('RPC 网络连接失败，请检查端点、CORS 与网络状态');
      throw error;
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
  } };
}
