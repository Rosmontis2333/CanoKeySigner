// Display names only. Transaction encoding and signatures always use the original numeric ID.
const names: Readonly<Record<string, string>> = Object.freeze({
  '5042': 'Arc（USDC）',
  '1': 'Ethereum Mainnet', '11155111': 'Ethereum Sepolia',
  '10': 'OP Mainnet', '11155420': 'OP Sepolia',
  '42161': 'Arbitrum One', '42170': 'Arbitrum Nova', '421614': 'Arbitrum Sepolia',
  '8453': 'Base', '84532': 'Base Sepolia',
  '137': 'Polygon', '80002': 'Polygon Amoy',
  '56': 'BNB Smart Chain', '97': 'BNB Smart Chain Testnet',
  '43114': 'Avalanche C-Chain', '43113': 'Avalanche Fuji C-Chain',
});

export function evmNetworkLabel(chainId: string): string {
  return `${names[chainId] ?? 'EVM 链（未内置名称）'} · chainId ${chainId}`;
}

export function evmChainReference(caipChain: string): string {
  const match = /^eip155:([1-9][0-9]{0,31})$/.exec(caipChain);
  if (!match) throw new Error('EVM 会话 chainId 无效');
  return match[1]!;
}
