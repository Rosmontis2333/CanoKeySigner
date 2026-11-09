import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { rpcEndpoints, SOLANA_GENESIS } from '../src/network/config';
import { createRpcClient, rpcContext, rpcObject } from '../src/network/rpc';
import { readSolanaRpcContext } from '../src/network/solana';
import { solanaFixture, solanaSigner } from './fixtures/solana';

const startedAt = new Date().toISOString(), endpoint = rpcEndpoints()[0]!;
const methods: string[] = [];
const fetcher: typeof fetch = (url, options) => {
  methods.push((JSON.parse(options!.body as string) as { method: string }).method);
  return fetch(url, options);
};
let status = 'passed', error: string | undefined;
let rows: readonly (readonly [string, string])[] = [];
let signable: boolean | undefined;
try {
  const signal = new AbortController().signal, rpc = createRpcClient(endpoint, fetcher);
  assert.equal(await rpc.call('getGenesisHash', [], signal), SOLANA_GENESIS.devnet);
  const latest = rpcContext(await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }], signal));
  const blockhash = rpcObject(latest.value).blockhash; assert.equal(typeof blockhash, 'string');
  const account = rpcContext(await rpc.call('getMultipleAccounts', [['11111111111111111111111111111111'], { encoding: 'base64', commitment: 'confirmed' }], signal));
  assert.ok(Array.isArray(account.value) && account.value.length === 1);
  const fixture = solanaFixture(); fixture.transaction.message.recentBlockhash = blockhash as string;
  const result = await readSolanaRpcContext(endpoint, { source: base64.encode(fixture.transaction.serialize()),
    publicKeyHex: bytesToHex(solanaSigner.publicKey.toBytes()), network: 'devnet', encoding: 'base64', format: 'transaction' }, signal, fetcher);
  rows = result.review.rows.filter(([label]) => label.startsWith('RPC'));
  signable = result.review.signable;
  if (rows.some(([label, value]) => label === 'RPC 模拟结果' && value.startsWith('模拟失败'))) assert.equal(signable, false);
  assert.ok(rows.some(([label, value]) => label === 'RPC 费用（lamports）' && /^\d+$/.test(value)));
  assert.ok(rows.some(([label]) => label === 'RPC 模拟结果'));
  assert.ok(methods.every((method) => ['getGenesisHash', 'getLatestBlockhash', 'getMultipleAccounts', 'getFeeForMessage', 'simulateTransaction'].includes(method)));
} catch (failure) { status = 'failed'; error = failure instanceof Error ? failure.message : 'RPC live validation failed'; }
const report = { status, startedAt, finishedAt: new Date().toISOString(), endpoint: new URL(endpoint.url).origin,
  data: 'dedicated synthetic public key and transaction, no hardware or signature submission', methods, rows, signable, ...(error ? { error } : {}) };
if (process.argv[2]) { const output = resolve(process.argv[2]); await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
if (status !== 'passed') process.exitCode = 1;
