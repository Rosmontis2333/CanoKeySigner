import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { evmRpcEndpoints } from '../src/network/config';
import { createRpcClient } from '../src/network/rpc';
import { evmRpcQuantity, readEvmRpcContext } from '../src/network/evm';
import { relayDevice } from './fixtures/relay-device';

const endpoint = evmRpcEndpoints().find((item) => item.chainId === '11155111')!;
const account = relayDevice('evm').account, methods: string[] = [], startedAt = new Date().toISOString();
const fetcher: typeof fetch = (url, options) => {
  methods.push((JSON.parse(options!.body as string) as { method: string }).method);
  return fetch(url, options);
};
let status = 'passed', error: string | undefined, signable: boolean | undefined;
let rows: readonly (readonly [string, string])[] = [];
try {
  const signal = new AbortController().signal, rpc = createRpcClient(endpoint, fetcher);
  assert.equal(evmRpcQuantity(await rpc.call('eth_chainId', [], signal)), 11155111n);
  const nonce = evmRpcQuantity(await rpc.call('eth_getTransactionCount', [account.address, 'pending'], signal));
  const result = await readEvmRpcContext(endpoint, { publicKeyHex: account.publicKeyHex, source: JSON.stringify({
    type: '2', chainId: '11155111', nonce: nonce.toString(), gasLimit: '21000', value: '0',
    to: '0x000000000000000000000000000000000000dead', data: '0x', accessList: [],
    maxFeePerGas: '100000000000', maxPriorityFeePerGas: '1000000000',
  }) }, signal, fetcher);
  rows = result.review.rows.filter(([label]) => label.startsWith('RPC')); signable = result.review.signable;
  assert.ok(rows.some(([label]) => label === 'RPC 参考区块'));
  assert.ok(rows.some(([label]) => label === 'RPC gas 估计' || label === 'RPC 签名策略'));
  assert.ok(methods.every((method) => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getBalance', 'eth_getCode', 'eth_call', 'eth_estimateGas'].includes(method)));
} catch (failure) { status = 'failed'; error = failure instanceof Error ? failure.message : 'EVM RPC live validation failed'; }
const report = { status, startedAt, finishedAt: new Date().toISOString(), endpoint: new URL(endpoint.url).origin,
  data: 'dedicated synthetic public key and unsigned zero-value Sepolia transaction', methods, rows, signable, ...(error ? { error } : {}) };
if (process.argv[2]) { const output = resolve(process.argv[2]); await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
if (status !== 'passed') process.exitCode = 1;
