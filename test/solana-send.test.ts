import assert from 'node:assert/strict';
import test from 'node:test';
import { base64 } from '@scure/base';
import { solanaSendOptions } from '../src/chains/solana/send-options';
import { sessionNamespaces, walletTransactionSources } from '../src/connectors/walletconnect/policy';
import { readWalletRpcRequest } from '../src/connectors/walletconnect/rpc';
import { relayDevice } from './fixtures/relay-device';
import { solanaFixture } from './fixtures/solana';
import { walletRpcFixture } from './fixtures/wallet-rpc';

test('Solana send options preserve documented commitment values and validate every field with immutable defaults', () => {
  assert.deepEqual(solanaSendOptions(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
  for (const preflightCommitment of ['processed', 'confirmed', 'finalized', 'recent', 'single', 'singleGossip', 'root', 'max']) {
    const input = { preflightCommitment, skipPreflight: true, maxRetries: 5, minContextSlot: 10 }, parsed = solanaSendOptions(input);
    assert.deepEqual(parsed, input); assert.ok(Object.isFrozen(parsed));
    input.maxRetries = 9; assert.equal(parsed.maxRetries, 5);
  }
  for (const value of [null, [], '', { extra: true }, { encoding: 'base58' }, { skipPreflight: 1 }, { skipPreflight: null },
    { preflightCommitment: 'latest' }, { preflightCommitment: null }, { minContextSlot: null }, { maxRetries: null },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1'].flatMap((number) => [{ maxRetries: number }, { minContextSlot: number }])]) {
    assert.throws(() => solanaSendOptions(value));
  }
});

test('Solana send capabilities follow configured cluster RPC availability and keep signing capabilities separate', () => {
  const account = relayDevice('solana').account;
  const namespace = { chains: [account.chainId], methods: ['solana_signTransaction', 'solana_signAndSendTransaction'], events: [] };
  assert.deepEqual(sessionNamespaces({ requiredNamespaces: { solana: namespace }, optionalNamespaces: {} }, account, () => true).solana!.methods, namespace.methods);
  assert.throws(() => sessionNamespaces({ requiredNamespaces: { solana: namespace }, optionalNamespaces: {} }, account, () => false));
  assert.deepEqual(sessionNamespaces({ requiredNamespaces: {}, optionalNamespaces: { solana: namespace } }, account, () => false).solana!.methods, ['solana_signTransaction']);
});

test('Solana send accepts only complete transaction envelopes, current accounts and documented sendOptions', () => {
  const account = relayDevice('solana').account, bytes = solanaFixture(false, true).bytes;
  const input = { transaction: base64.encode(bytes), pubkey: account.address, sendOptions: { skipPreflight: true, maxRetries: 0 } };
  assert.deepEqual(walletTransactionSources(account, 'solana_signAndSendTransaction', input), [input.transaction]);
  assert.deepEqual(walletTransactionSources(account, 'solana_signAndSendTransaction', { transaction: input.transaction }), [input.transaction]);
  for (const value of [[], { ...input, pubkey: 'wrong' }, { ...input, sendOptions: { skipPreflight: 'yes' } },
    { ...input, options: {} }, { ...input, transaction: Array.from(bytes) }, { ...input, transaction: input.transaction + 'AA' }]) {
    assert.throws(() => walletTransactionSources(account, 'solana_signAndSendTransaction', value));
  }
  assert.throws(() => walletTransactionSources(account, 'solana_signTransaction', input));
  const partial = bytes.slice(); partial.fill(0, 65, 129);
  assert.throws(() => walletTransactionSources(account, 'solana_signAndSendTransaction', { transaction: base64.encode(partial) }), /协签/);
});

test('Solana send carries the requested commitment and minimum slot through ALT, fees and simulation and refuses stale context', async () => {
  const account = relayDevice('solana').account, rpc = walletRpcFixture('solana'), tx = solanaFixture(true, true);
  const params = { transaction: base64.encode(tx.bytes), sendOptions: { skipPreflight: true, preflightCommitment: 'finalized', minContextSlot: 10, maxRetries: 4 } };
  const result = await readWalletRpcRequest(account, 'solana_signAndSendTransaction', params, rpc.endpoint, new AbortController().signal, rpc.fetcher);
  assert.ok(result.reviews[0]!.signable);
  assert.ok(result.reviews[0]!.rows.some(([label, value]) => label === '提交请求 sendOptions（固定值）' && value.includes('finalized')));
  const alt = rpc.calls.find((call) => call.method === 'getMultipleAccounts')!;
  assert.deepEqual(alt.params[1], { encoding: 'base64', commitment: 'finalized', minContextSlot: 10 });
  assert.deepEqual(rpc.calls.find((call) => call.method === 'getFeeForMessage')!.params[1], { commitment: 'finalized', minContextSlot: 11 });
  assert.deepEqual(rpc.calls.find((call) => call.method === 'simulateTransaction')!.params[1], {
    encoding: 'base64', commitment: 'finalized', minContextSlot: 12, sigVerify: false, replaceRecentBlockhash: false,
  });
  await assert.rejects(readWalletRpcRequest(account, 'solana_signAndSendTransaction', { ...params, sendOptions: { minContextSlot: 14 } }, rpc.endpoint, new AbortController().signal, rpc.fetcher), /slot/);
  const failed = walletRpcFixture('solana'); failed.results.simulateTransaction = { context: { slot: 13 }, value: { err: 'BlockhashNotFound', logs: [] } };
  const refused = await readWalletRpcRequest(account, 'solana_signAndSendTransaction', params, failed.endpoint, new AbortController().signal, failed.fetcher);
  assert.equal(refused.reviews[0]!.signable, false);
});
