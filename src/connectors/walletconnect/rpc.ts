import type { WalletAccount } from '../../ui/accounts';
import type { EvmRpcEndpoint, SolanaRpcEndpoint } from '../../network/config';
import { readEvmRpcContext, readEvmSendContext } from '../../network/evm';
import { readSolanaRpcContext } from '../../network/solana';
import { walletTransactionSources } from './policy';
import type { EvmReview } from '../../chains/evm/transaction';
import type { SolanaReview } from '../../chains/solana/transaction';
import { withSolanaRpcContext } from '../../chains/solana/transaction';
import { solanaSendOptions } from '../../chains/solana/send-options';

export async function readWalletRpcRequest(account: WalletAccount, method: string, params: unknown,
  endpoint: EvmRpcEndpoint | SolanaRpcEndpoint, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const sources = walletTransactionSources(account, method, params);
  const reviews: (EvmReview | SolanaReview)[] = [];
  let expiresAt = Date.now() + 120000;
  for (const source of sources) {
    signal.throwIfAborted();
    if (Date.now() >= expiresAt) throw new Error('整批 RPC 上下文已过期，请重新读取');
    let result;
    if (account.coin === 'evm' && 'chainId' in endpoint && endpoint.chainId === account.network) {
      result = method === 'eth_sendTransaction'
        ? await readEvmSendContext(endpoint, { source, publicKeyHex: account.publicKeyHex, chainId: account.network }, signal, fetcher)
        : await readEvmRpcContext(endpoint, { source, publicKeyHex: account.publicKeyHex }, signal, fetcher);
    } else if (account.coin === 'solana' && 'network' in endpoint && endpoint.network === account.network) {
      const options = method === 'solana_signAndSendTransaction' ? solanaSendOptions((params as Record<string, unknown>).sendOptions) : undefined;
      result = await readSolanaRpcContext(endpoint, { source, publicKeyHex: account.publicKeyHex, network: account.network,
        encoding: 'base64', format: 'transaction', ...(options ? { commitment: options.preflightCommitment, minContextSlot: options.minContextSlot ?? 0 } : {}) }, signal, fetcher);
      if (options) {
        const rows: [string, string][] = [['提交请求 sendOptions（固定值）', JSON.stringify(options)],
          ['节点提交预检', options.skipPreflight
            ? 'dApp 请求跳过节点在提交时的预检。应用仍先完成消息审查、全部必需签名校验与发送前 RPC 模拟。'
            : '提交时要求节点再次预检。'],
          ['节点重传次数上限', `${options.maxRetries}，仅重传同一份签名交易。应用按同一标识最多发起一次提交。`],
          ['提交上下文下限', options.minContextSlot === undefined ? 'dApp 未指定最小 slot' : String(options.minContextSlot)]];
        result = { ...result, review: withSolanaRpcContext(result.review, { transactionHex: result.review.transactionHex, network: account.network,
          expiresAt: result.expiresAt, accepted: true, rows }) };
      }
    } else throw new Error('RPC 来源与已授权请求的网络不一致');
    expiresAt = Math.min(expiresAt, result.expiresAt);
    reviews.push(result.review);
  }
  signal.throwIfAborted();
  if (Date.now() >= expiresAt) throw new Error('整批 RPC 上下文已过期，请重新读取');
  return { reviews: Object.freeze(reviews), expiresAt };
}
