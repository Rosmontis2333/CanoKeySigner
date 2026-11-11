import type { ProposalTypes, SessionTypes } from '@walletconnect/types';
import type { WalletAccount } from '../../ui/accounts';
import { prepareEvmTransaction } from '../../chains/evm/transaction';
import { prepareSolanaTransaction, decodeSolanaEnvelope } from '../../chains/solana/transaction';
import { prepareEvmMessage } from '../../chains/evm/message';
import { evmChainReference } from '../../chains/evm/networks';
import { prepareSolanaMessage } from '../../chains/solana/message';
import { solanaSendOptions } from '../../chains/solana/send-options';
export const walletMethods = { evm: ['eth_signTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'], bitcoin: [], solana: ['solana_getAccounts', 'solana_signTransaction', 'solana_signAllTransactions', 'solana_signAndSendTransaction', 'solana_signMessage'] } as const;
export const SOLANA_BATCH_LIMIT = 8;
export function walletSendsTransaction(method: string): boolean {
  return method === 'eth_sendTransaction' || method === 'solana_signAndSendTransaction';
}
export function sessionNamespaces(proposal: Pick<ProposalTypes.Struct, 'requiredNamespaces' | 'optionalNamespaces'>, account: WalletAccount,
  canSubmit: (chainId: string) => boolean = () => true): SessionTypes.Namespaces {
  if (account.coin === 'bitcoin') throw new Error('Bitcoin 仅提供手动签名');
  const automaticEvm = account.coin === 'evm' && !account.chainId;
  const namespace = account.coin === 'evm' ? 'eip155' : account.chainId.split(':')[0]!;
  const supported: readonly string[] = walletMethods[account.coin];
  function supportsChain(chain: string): boolean {
    if (!automaticEvm) return chain === account.chainId;
    try { evmChainReference(chain); return true; } catch { return false; }
  }
  function requestedChains(key: string, request: { chains?: string[] | undefined }): string[] {
    const chains = request.chains ?? (key.includes(':') ? [key] : []);
    if (key.includes(':') && chains.some((chain) => chain !== key)) throw new Error('提案 namespace 与 chainId 不一致');
    return chains;
  }
  const entries = [...Object.entries(proposal.requiredNamespaces), ...Object.entries(proposal.optionalNamespaces)];
  if (entries.length > 32) throw new Error('连接提案的 namespace 数量超过 32');
  for (const [key, request] of Object.entries(proposal.requiredNamespaces)) {
    const chains = requestedChains(key, request);
    if ((key !== namespace && !supportsChain(key)) || !chains.length || chains.length > 32 || chains.some((chain) => !supportsChain(chain))
      || request.methods.some((method) => !supported.includes(method)) || request.events.length) throw new Error('此连接要求尚未实现的链、方法或事件');
    if (account.coin !== 'evm' && request.methods.some(walletSendsTransaction) && chains.some((chain) => !canSubmit(chain))) throw new Error('此连接要求的提交网络尚未配置 RPC 来源');
  }
  const chains = new Set<string>(), methods = new Set<string>();
  const granted: SessionTypes.Namespaces = {};
  for (const [key, request] of entries) {
    if (key !== namespace && !supportsChain(key)) continue;
    const acceptedChains = requestedChains(key, request).filter(supportsChain);
    const acceptedMethods = request.methods.filter((method) => supported.includes(method)
      && (account.coin === 'evm' || !walletSendsTransaction(method) || acceptedChains.some(canSubmit)));
    if (!acceptedChains.length || !acceptedMethods.length) continue;
    for (const chain of acceptedChains) chains.add(chain);
    for (const method of acceptedMethods) methods.add(method);
    if (chains.size > 32) throw new Error('连接提案的链数量超过 32');
    // Keep chain-qualified namespace permissions local to that namespace.
    const previous = granted[key];
    const combinedChains = [...new Set([...(previous?.chains ?? []), ...acceptedChains])];
    granted[key] = { chains: combinedChains, accounts: combinedChains.map((chain) => `${chain}:${account.address}`),
      methods: [...new Set([...(previous?.methods ?? []), ...acceptedMethods])], events: [] };
  }
  // EVM sessions can connect before RPC availability is known. Sending checks
  // the RPC at request time. Solana send permissions remain scoped by RPC.
  for (const [key, grantedNamespace] of Object.entries(granted)) {
    const sendMethods = grantedNamespace.methods.filter(walletSendsTransaction);
    const grantedChains = grantedNamespace.chains ?? [];
    if (account.coin === 'evm' || !sendMethods.length || grantedChains.every(canSubmit)) continue;
    const otherMethods = grantedNamespace.methods.filter((method) => !walletSendsTransaction(method));
    if (otherMethods.length) granted[key] = { ...grantedNamespace, methods: otherMethods };
    else delete granted[key];
    for (const chain of grantedChains.filter(canSubmit)) {
      const previous = granted[chain];
      granted[chain] = { chains: [chain], accounts: [`${chain}:${account.address}`],
        methods: [...new Set([...(previous?.methods ?? []), ...sendMethods])], events: [] };
    }
  }
  if (!methods.size) throw new Error('没有可以授予的请求能力');
  return granted;
}

export function accountForWalletRequest(account: WalletAccount, namespaces: SessionTypes.Namespaces, chainId: string, method: string): WalletAccount {
  if (account.coin === 'bitcoin') throw new Error('Bitcoin 仅提供手动签名');
  const namespace = account.coin === 'evm' ? 'eip155' : account.chainId.split(':')[0]!;
  const authorized = [namespaces[chainId], namespaces[namespace]].some((granted) => granted?.chains?.includes(chainId)
    && granted.methods.includes(method) && granted.accounts.includes(`${chainId}:${account.address}`));
  if (!authorized) throw new Error('请求的链、账户或方法未获得授权');
  if (account.coin === 'evm' && !account.chainId) return { ...account, network: evmChainReference(chainId), chainId };
  if (chainId !== account.chainId) throw new Error('请求 chainId 与授权账户不一致');
  return account;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数需要对象');
  return value as Record<string, unknown>;
}
export function walletTransactionSources(account: WalletAccount, method: string, params: unknown): readonly string[] {
  if (JSON.stringify(params)?.length > 262144) throw new Error('请求参数超过 256 KiB');
  if (account.coin === 'evm' && ['eth_signTransaction', 'eth_sendTransaction'].includes(method)) {
    if (!Array.isArray(params) || params.length !== 1) throw new Error('EVM 参数需要单笔交易数组');
    const input = object(params[0]);
    if (typeof input.from !== 'string' || input.from.toLowerCase() !== account.address.toLowerCase()) throw new Error('EVM from 与授权账户不一致');
    const sending = method === 'eth_sendTransaction';
    const fields = new Set(['from', 'type', 'chainId', 'nonce', 'gas', 'gasLimit', 'to', 'value', 'data', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'accessList', ...(sending ? ['input'] : [])]);
    for (const key of Object.keys(input)) if (!fields.has(key)) throw new Error(`未知 EVM 请求字段 ${key}`);
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'from') continue;
      normalized[key === 'gas' ? 'gasLimit' : key === 'input' ? 'data' : key] = value;
    }
    if (input.gas !== undefined && input.gasLimit !== undefined) throw new Error('重复 gas / gasLimit');
    if (input.data !== undefined && input.input !== undefined) throw new Error('重复 data / input');
    return [JSON.stringify(normalized)];
  }
  if (account.coin !== 'solana' || !['solana_signTransaction', 'solana_signAllTransactions', 'solana_signAndSendTransaction'].includes(method)) throw new Error('此请求不支持交易 RPC 检查');
  const input = object(params);
  let sources: unknown[];
  if (method === 'solana_signAllTransactions') {
    if (Object.keys(input).some((key) => key !== 'transactions') || !Array.isArray(input.transactions)
      || input.transactions.length < 1 || input.transactions.length > SOLANA_BATCH_LIMIT) throw new Error(`批量请求需要 1–${SOLANA_BATCH_LIMIT} 笔交易`);
    sources = input.transactions;
  } else {
    const sending = method === 'solana_signAndSendTransaction';
    if (Object.keys(input).some((key) => !['transaction', 'pubkey', ...(sending ? ['sendOptions'] : [])].includes(key)) || typeof input.transaction !== 'string'
      || (input.pubkey !== undefined && input.pubkey !== account.address)) throw new Error('Solana 请求账户或参数无效');
    if (sending) solanaSendOptions(input.sendOptions);
    sources = [input.transaction];
  }
  for (const source of sources) {
    if (typeof source !== 'string' || source.length > 5464) throw new Error('交易需要不超过 4096 字节的 Base64 transaction');
    const envelope = decodeSolanaEnvelope(source);
    if (method === 'solana_signAndSendTransaction') {
      const signerIndex = envelope.message.addresses.slice(0, envelope.message.signers).indexOf(account.address);
      if (signerIndex < 0) throw new Error('提交账户不属于 required signer');
      if (envelope.signatures.some((signature, index) => index !== signerIndex && !signature.some((byte) => byte !== 0))) throw new Error('提交前需要其他所有必需签名，尚有协签缺失');
    }
  }
  return sources as string[];
}
export function reviewWalletBatchRequest(account: WalletAccount, params: unknown, snapshots: string) {
  if (account.coin !== 'solana') throw new Error('批量交易签名仅适用于 Solana');
  const sources = walletTransactionSources(account, 'solana_signAllTransactions', params);
  const reviews = sources.map((source) => prepareSolanaTransaction(source, account.publicKeyHex, account.network, 'base64', 'transaction', snapshots));
  if (reviews.some((review) => !review.signable)) throw new Error('批量请求包含不满足签名策略的交易');
  return Object.freeze(reviews);
}
export function reviewWalletRequest(account: WalletAccount, method: string, params: unknown, snapshots: string) {
  if (account.coin === 'bitcoin') throw new Error('Bitcoin 仅提供手动签名');
  if (JSON.stringify(params)?.length > 262144) throw new Error('请求参数超过 256 KiB');
  if (account.coin === 'evm' && (method === 'personal_sign' || method === 'eth_signTypedData_v4')) {
    if (!Array.isArray(params) || params.length !== 2) throw new Error('EVM 消息需要消息与账户两个参数');
    const requestedAddress = params[method === 'personal_sign' ? 1 : 0];
    if (typeof requestedAddress !== 'string' || requestedAddress.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error('消息签名账户与授权账户不一致');
    }
    const input = params[method === 'personal_sign' ? 0 : 1];
    if (method === 'personal_sign' && typeof input !== 'string') throw new Error('personal_sign 消息需要 Hex 字节');
    const source = typeof input === 'string' ? input : JSON.stringify(object(input));
    return prepareEvmMessage(method, source, account.publicKeyHex, account.network, 'hex');
  }
  if (account.coin === 'solana' && method === 'solana_signTransaction') {
    return prepareSolanaTransaction(walletTransactionSources(account, method, params)[0]!, account.publicKeyHex, account.network, 'base64', 'transaction', snapshots);
  }
  if (account.coin === 'solana' && method === 'solana_signMessage') {
    const input = object(params);
    if (Object.keys(input).some((key) => !['message', 'pubkey'].includes(key)) || typeof input.message !== 'string'
      || input.pubkey !== account.address) throw new Error('Solana 消息需要 Base58 message 和当前账户 pubkey');
    return prepareSolanaMessage(input.message, account.publicKeyHex, account.network, 'base58');
  }
  if (account.coin === 'evm' && method === 'eth_signTransaction') return prepareEvmTransaction(walletTransactionSources(account, method, params)[0]!, account.publicKeyHex, account.network);
  throw new Error('当前账户没有授予此签名方法');
}
