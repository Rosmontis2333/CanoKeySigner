import { strictJson } from '../signing/json.ts';

export const SOLANA_GENESIS: Readonly<Record<string, string>> = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
});
export interface SolanaRpcEndpoint { readonly name: string; readonly url: string; readonly network: string }
export interface EvmRpcEndpoint { readonly name: string; readonly url: string; readonly chainId: string }
const defaults = [
  { name: 'Solana 公共 Devnet', network: 'devnet', url: 'https://api.devnet.solana.com/' },
  { name: 'Solana 公共 Mainnet', network: 'mainnet-beta', url: 'https://api.mainnet-beta.solana.com/' },
  { name: 'Solana 公共 Testnet', network: 'testnet', url: 'https://api.testnet.solana.com/' },
];

export function rpcUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value.length > 2048 || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.hash) throw new Error('RPC 需要 HTTPS，或本机 HTTP，URL 不可包含登录凭据或 fragment');
  return url.href;
}
export function validateRpcEndpoint(value: unknown): SolanaRpcEndpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RPC 配置需要对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['name', 'url', 'network'].includes(key)) || typeof input.name !== 'string'
    || !input.name.trim() || input.name.length > 80 || typeof input.url !== 'string' || input.url.length > 2048
    || typeof input.network !== 'string' || !Object.hasOwn(SOLANA_GENESIS, input.network)) throw new Error('RPC 配置的名称、URL 或网络无效');
  return Object.freeze({ name: input.name, url: rpcUrl(input.url), network: input.network });
}

export function rpcEndpoints(source?: string): readonly SolanaRpcEndpoint[] {
  const inputs: unknown = source === undefined ? defaults : strictJson(source);
  if (!Array.isArray(inputs) || inputs.length > 16) throw new Error('RPC 配置需要至多 16 个端点');
  const endpoints = inputs.map(validateRpcEndpoint);
  if (new Set(endpoints.map((endpoint) => endpoint.url)).size !== endpoints.length) throw new Error('RPC 配置包含重复 URL');
  return Object.freeze(endpoints);
}

export function validateEvmRpcEndpoint(value: unknown): EvmRpcEndpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EVM RPC 配置需要对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['name', 'url', 'chainId'].includes(key)) || typeof input.name !== 'string'
    || !input.name.trim() || input.name.length > 80 || typeof input.url !== 'string' || typeof input.chainId !== 'string'
    || !/^[1-9][0-9]{0,77}$/.test(input.chainId) || BigInt(input.chainId) >= 1n << 256n) throw new Error('EVM RPC 名称、URL 或 chainId 无效');
  return Object.freeze({ name: input.name, url: rpcUrl(input.url), chainId: input.chainId });
}

export function evmRpcEndpoints(source?: string): readonly EvmRpcEndpoint[] {
  const inputs: unknown = source === undefined ? [
    { name: 'PublicNode · Ethereum', chainId: '1', url: 'https://ethereum-rpc.publicnode.com/' },
    { name: 'Base', chainId: '8453', url: 'https://base-rpc.publicnode.com/' },
    { name: 'Arbitrum One', chainId: '42161', url: 'https://arb1.arbitrum.io/rpc' },
    { name: 'BNB Smart Chain', chainId: '56', url: 'https://bsc-dataseed.bnbchain.org/' },
    { name: 'Arc', chainId: '5042', url: 'https://rpc.mainnet.arc.io/' },
  ] : strictJson(source);
  if (!Array.isArray(inputs) || inputs.length > 32) throw new Error('EVM RPC 配置需要至多 32 个端点');
  const endpoints = inputs.map(validateEvmRpcEndpoint);
  if (new Set(endpoints.map((endpoint) => `${endpoint.chainId}:${endpoint.url}`)).size !== endpoints.length) throw new Error('EVM RPC 配置重复');
  return Object.freeze(endpoints);
}

export function networkPolicyHtml(html: string, offline: boolean, endpoints: readonly { url: string }[]): string {
  const sources = [...new Set(endpoints.map((endpoint) => new URL(endpoint.url).origin))];
  return html.replace(/connect-src [^;]+;/, (policy) => offline ? "connect-src 'none';" : `${policy.slice(0, -1)}${sources.length ? ' ' + sources.join(' ') : ''};`);
}
