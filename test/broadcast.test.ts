import assert from 'node:assert/strict';
import test from 'node:test';
import { base58, base64 } from '@scure/base';
import { Transaction } from 'micro-eth-signer';
import { VersionedTransaction } from '@solana/web3.js';
import { prepareBroadcast, submitBroadcast, queryBroadcast } from '../src/network/broadcast';
import { createRpcClient } from '../src/network/rpc';
import { prepareEvmTransaction } from '../src/chains/evm/transaction';
import { prepareSolanaTransaction } from '../src/chains/solana/transaction';
import { executeReviewedTransaction } from '../src/signing/execute';
import { solanaFixture, solanaOther } from './fixtures/solana';
import { solanaV1Fixture, encodeV1Fixture } from './fixtures/solana-v1';
import { relayDevice } from './fixtures/relay-device';
import { walletRpcFixture } from './fixtures/wallet-rpc';

let nonce = 1000, blockhash = 20;
async function fixture(coin: 'evm' | 'solana', version: 'legacy' | 'v0' | 'v1' = 'legacy', multi = false) {
  const device = relayDevice(coin), rpc = walletRpcFixture(coin);
  let review;
  if (coin === 'evm') {
    const current = nonce++;
    rpc.results.eth_getTransactionCount = `0x${current.toString(16)}`;
    review = prepareEvmTransaction(JSON.stringify({ type: '2', chainId: '31337', nonce: String(current), gasLimit: '21000', value: '0',
      to: '0x0000000000000000000000000000000000000001', data: '0x', accessList: [], maxFeePerGas: '2', maxPriorityFeePerGas: '1' }), device.account.publicKeyHex);
  } else {
    const hash = base58.encode(new Uint8Array(32).fill(blockhash++));
    if (version === 'v1') {
      const original = solanaV1Fixture(multi);
      const transaction = encodeV1Fixture({ ...original.compiled, lifetimeToken: hash as typeof original.compiled.lifetimeToken }, multi);
      review = prepareSolanaTransaction(base64.encode(transaction.bytes), device.account.publicKeyHex, 'devnet');
    } else {
      const transaction = solanaFixture(version === 'v0', multi);
      transaction.transaction.message.recentBlockhash = hash;
      if (multi) transaction.transaction.sign([solanaOther]);
      review = prepareSolanaTransaction(base64.encode(transaction.transaction.serialize()), device.account.publicKeyHex, 'devnet', 'base64', 'transaction', transaction.snapshots);
    }
  }
  const signed = await executeReviewedTransaction(device.access, review, device.account.slot, new TextEncoder().encode('123456'));
  const task = prepareBroadcast(review, signed.output, rpc.endpoint);
  rpc.results.eth_getTransactionReceipt = null; rpc.results.eth_getTransactionByHash = null;
  rpc.results.getSignatureStatuses = { context: { slot: 20 }, value: [null] };
  rpc.results.eth_sendRawTransaction = task.id; rpc.results.sendTransaction = task.id;
  return { ...rpc, device, review, signed: signed.output, task };
}
const signal = () => new AbortController().signal;

for (const coin of ['evm', 'solana'] as const) test(`Explicit ${coin} submission validates the original signed bytes, preflights and returns only a matching identifier`, async () => {
  const f = await fixture(coin);
  assert.ok(Object.isFrozen(f.task)); assert.ok(Object.isFrozen(f.task.rows[0]));
  assert.equal(f.calls.length, 0);
  const accepted = await submitBroadcast(f.task, signal(), f.fetcher);
  assert.equal(accepted.state, 'accepted');
  const send = f.calls.filter((call) => ['eth_sendRawTransaction', 'sendTransaction'].includes(call.method));
  assert.equal(send.length, 1); assert.equal(send[0]!.params[0], f.signed);
  if (coin === 'evm') {
    assert.equal(Transaction.fromHex(f.signed).sender, f.device.account.address);
    assert.ok(f.calls.some((call) => call.method === 'eth_call'));
  } else {
    assert.deepEqual(send[0]!.params[1], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
    const decoded = VersionedTransaction.deserialize(base64.decode(f.signed));
    assert.equal(f.task.id, base58.encode(decoded.signatures[0]!));
  }
  await assert.rejects(submitBroadcast(f.task, signal(), f.fetcher), /已尝试/);
  assert.equal(f.calls.filter((call) => call.method === send[0]!.method).length, 1);
});

for (const version of ['legacy', 'v0', 'v1'] as const) test(`Solana ${version} broadcasts only complete multisig transactions and preserves every signature`, async () => {
  const f = await fixture('solana', version, true);
  assert.equal((await submitBroadcast(f.task, signal(), f.fetcher)).state, 'accepted');
  const request = f.calls.find((call) => call.method === 'sendTransaction')!;
  assert.equal(request.params[0], f.signed);
});

test('Broadcast preparation rejects forged reviews, a different network and mutated signatures or transaction fields', async () => {
  const f = await fixture('evm');
  assert.ok(f.review.chain === 'evm');
  assert.throws(() => prepareBroadcast({ ...f.review }, f.signed, f.endpoint));
  assert.throws(() => prepareBroadcast(f.review, f.signed, { name: 'wrong', chainId: '1', url: 'https://wrong.example/' }));
  const transaction = Transaction.fromHex(f.signed);
  assert.throws(() => prepareBroadcast(f.review, transaction.toHex({ includeSignature: false }), f.endpoint));
  const corrupted = f.signed.slice(0, -2) + (f.signed.endsWith('00') ? '01' : '00');
  assert.throws(() => prepareBroadcast(f.review, corrupted, f.endpoint));
  const solana = await fixture('solana', 'v0', true);
  assert.throws(() => prepareBroadcast(solana.review, solana.signed, { name: 'wrong', network: 'testnet', url: 'https://wrong.example/' }));
  const bytes = base64.decode(solana.signed); bytes[100] = bytes[100]! ^ 1;
  assert.throws(() => prepareBroadcast(solana.review, base64.encode(bytes), solana.endpoint));
  assert.equal(f.calls.length + solana.calls.length, 0);
});

test('Solana partial multisig remains exportable but cannot prepare broadcast', async () => {
  const device = relayDevice('solana'), rpc = walletRpcFixture('solana'), original = solanaFixture(false, true);
  original.transaction.signatures[1] = new Uint8Array(64);
  const review = prepareSolanaTransaction(base64.encode(original.transaction.serialize()), device.account.publicKeyHex, 'devnet');
  const signed = await executeReviewedTransaction(device.access, review, device.account.slot, new TextEncoder().encode('123456'));
  assert.throws(() => prepareBroadcast(review, signed.output, rpc.endpoint), /协签/); assert.equal(rpc.calls.length, 0);
});

for (const coin of ['evm', 'solana'] as const) test(`${coin} wrong-network and failed execution prechecks do not send signed bytes`, async () => {
  const wrong = await fixture(coin);
  wrong.results[coin === 'evm' ? 'eth_chainId' : 'getGenesisHash'] = coin === 'evm' ? '0x1' : 'wrong';
  assert.equal((await submitBroadcast(wrong.task, signal(), wrong.fetcher)).state, 'not-sent');
  assert.equal(wrong.calls.length, 1);
  const failed = await fixture(coin);
  if (coin === 'evm') failed.results.eth_getBalance = '0x0';
  else failed.results.simulateTransaction = { context: { slot: 13 }, value: { err: 'BlockhashNotFound', logs: [] } };
  assert.equal((await submitBroadcast(failed.task, signal(), failed.fetcher)).state, 'not-sent');
  assert.ok(!failed.calls.some((call) => ['eth_sendRawTransaction', 'sendTransaction'].includes(call.method)));
});

test('An existing EVM receipt, including execution failure, avoids duplicate submission', async () => {
  for (const execution of ['0x0', '0x1']) {
    const f = await fixture('evm');
    f.results.eth_getTransactionReceipt = { transactionHash: f.task.id, blockNumber: '0x64', blockHash: '0x' + '12'.repeat(32), status: execution };
    const result = await submitBroadcast(f.task, signal(), f.fetcher);
    assert.equal(result.state, execution === '0x0' ? 'failed' : 'confirmed');
    assert.equal(f.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 0);
  }
});

test('Solana status queries distinguish missing, processed, confirmed, finalized and execution failure', async () => {
  const f = await fixture('solana');
  assert.equal((await queryBroadcast(f.task, signal(), f.fetcher)).state, 'unknown');
  for (const confirmationStatus of ['processed', 'confirmed', 'finalized']) {
    f.results.getSignatureStatuses = { context: { slot: 20 }, value: [{ slot: 19, err: null, confirmationStatus }] };
    const result = await queryBroadcast(f.task, signal(), f.fetcher);
    assert.equal(result.state, confirmationStatus === 'processed' ? 'pending' : 'confirmed');
  }
  f.results.getSignatureStatuses = { context: { slot: 20 }, value: [{ slot: 19, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] };
  assert.equal((await queryBroadcast(f.task, signal(), f.fetcher)).state, 'failed');
  assert.ok(!f.calls.some((call) => call.method === 'sendTransaction'));
});

test('A lost EVM send response is reconciled by the local hash without resubmission', async () => {
  const f = await fixture('evm'); let writes = 0;
  const fetcher: typeof fetch = async (url, options) => {
    const request = JSON.parse(options!.body as string) as { method: string };
    if (request.method === 'eth_sendRawTransaction') {
      writes++; f.results.eth_getTransactionByHash = { hash: f.task.id, blockHash: null };
      throw new TypeError('Response lost after receipt');
    }
    return f.fetcher(url, options);
  };
  const result = await submitBroadcast(f.task, signal(), fetcher);
  assert.equal(result.state, 'pending'); assert.equal(writes, 1);
  await assert.rejects(submitBroadcast(f.task, signal(), fetcher)); assert.equal(writes, 1);
});

test('A wrong returned ID or failed lookup leaves submission uncertain and permits read-only recovery', async () => {
  const f = await fixture('solana'); f.results.sendTransaction = 'wrong-transaction-id';
  assert.equal((await submitBroadcast(f.task, signal(), f.fetcher)).state, 'unknown');
  assert.equal((await queryBroadcast(f.task, signal(), f.fetcher)).state, 'unknown');
  f.results.getSignatureStatuses = { context: { slot: 20 }, value: [{ slot: 20, err: null, confirmationStatus: 'confirmed' }] };
  assert.equal((await queryBroadcast(f.task, signal(), f.fetcher)).state, 'confirmed');
  assert.equal(f.calls.filter((call) => call.method === 'sendTransaction').length, 1);
});

test('Cancellation after a write attempt retains an uncertain ID and never accepts a late response as confirmation', async () => {
  const f = await fixture('evm'), abort = new AbortController();
  let release!: () => void, writing!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), reached = new Promise<void>((resolve) => { writing = resolve; });
  const fetcher: typeof fetch = async (url, options) => {
    if ((JSON.parse(options!.body as string) as { method: string }).method === 'eth_sendRawTransaction') { writing(); await gate; }
    return f.fetcher(url, options);
  };
  const pending = submitBroadcast(f.task, abort.signal, fetcher);
  await reached; abort.abort(); release();
  assert.equal((await pending).state, 'unknown');
  assert.equal(f.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
  f.results.eth_getTransactionByHash = { hash: f.task.id };
  assert.equal((await queryBroadcast(f.task, signal(), f.fetcher)).state, 'pending');
});

test('Concurrent and newly prepared tasks cannot submit the same network and ID twice, including across RPC sources', async () => {
  const f = await fixture('evm');
  const other = prepareBroadcast(f.review, f.signed, { name: 'Second source', chainId: f.task.network, url: 'https://second.example/' });
  const pending = submitBroadcast(f.task, signal(), f.fetcher);
  await assert.rejects(submitBroadcast(f.task, signal(), f.fetcher));
  assert.equal((await pending).state, 'accepted');
  await assert.rejects(submitBroadcast(other, signal(), f.fetcher));
  assert.equal(f.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
});

test('Broadcast preparation expires and status queries reject mismatched receipt/signature state', async (context) => {
  const f = await fixture('evm');
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() }); context.mock.timers.tick(120001);
  await assert.rejects(submitBroadcast(f.task, signal(), f.fetcher), /过期/); assert.equal(f.calls.length, 0);
  f.results.eth_getTransactionReceipt = { transactionHash: '0x' + '00'.repeat(32), status: '0x1', blockNumber: '0x1', blockHash: '0x' + 'aa'.repeat(32) };
  await assert.rejects(queryBroadcast(f.task, signal(), f.fetcher), /标识/);
});

test('Read-only RPC clients cannot issue either broadcast method', async () => {
  const f = await fixture('evm');
  await assert.rejects(createRpcClient(f.endpoint, f.fetcher).call('eth_sendRawTransaction' as 'eth_call', [f.signed], signal()));
  await assert.rejects(createRpcClient(f.endpoint, f.fetcher).call('sendTransaction' as 'eth_call', [f.signed], signal()));
  assert.equal(f.calls.length, 0);
});
