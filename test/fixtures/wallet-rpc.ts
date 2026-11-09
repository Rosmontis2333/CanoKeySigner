import { solanaFixture } from './solana';
import { SOLANA_GENESIS } from '../../src/network/config';

/** Synthetic remote state for exercising the production RPC code without a broadcast. */
export function walletRpcFixture(coin: 'evm' | 'solana', chainId = '31337') {
  const calls: { method: string; params: unknown[] }[] = [];
  const snapshots = JSON.parse(solanaFixture(true).snapshots) as { owner: string; dataBase64: string }[];
  const results: Record<string, unknown> = coin === 'evm' ? {
    eth_chainId: `0x${BigInt(chainId).toString(16)}`, eth_getBlockByNumber: {
      number: '0x64', hash: '0x' + 'ab'.repeat(32), timestamp: '0x1234', gasLimit: '0x1c9c380', baseFeePerGas: '0x1',
    }, eth_getTransactionCount: '0x0', eth_getBalance: '0x' + 'f'.repeat(64), eth_getCode: '0x', eth_call: '0x', eth_estimateGas: '0x5208',
  } : {
    getGenesisHash: SOLANA_GENESIS.devnet,
    getMultipleAccounts: { context: { slot: 11 }, value: snapshots.map((item) => ({ executable: false, owner: item.owner, data: [item.dataBase64, 'base64'] })) },
    getFeeForMessage: { context: { slot: 12 }, value: 10000 },
    simulateTransaction: { context: { slot: 13 }, value: { err: null, unitsConsumed: 450, logs: ['Program success'] } },
  };
  const fetcher: typeof fetch = async (_url, options) => {
    const request = JSON.parse(options!.body as string) as { id: number; method: string; params: unknown[] };
    calls.push(request);
    if (!Object.hasOwn(results, request.method)) throw new Error(`Unexpected RPC method ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }));
  };
  return { calls, results, fetcher,
    endpoint: coin === 'evm' ? { name: 'Synthetic EVM context', chainId, url: 'https://synthetic-rpc.example/' }
      : { name: 'Synthetic Solana context', network: 'devnet', url: 'https://synthetic-rpc.example/' },
  };
}
