import assert from 'node:assert/strict';
import test from 'node:test';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readSolanaRpcContext } from '../src/network/solana';
import { rpcEndpoints, SOLANA_GENESIS } from '../src/network/config';
import { prepareSolanaTransaction, withSolanaRpcContext } from '../src/chains/solana/transaction';
import { approveSolanaTransaction } from '../src/signing/approval';
import { executeReviewedTransaction } from '../src/signing/execute';
import { solanaFixture, solanaSigner } from './fixtures/solana';
import { solanaV1Fixture } from './fixtures/solana-v1';
import { relayDevice } from './fixtures/relay-device';
import { TransactionInstruction } from '@solana/web3.js';
import { solanaOther } from './fixtures/solana';

const endpoint = rpcEndpoints()[0]!, publicKeyHex = bytesToHex(solanaSigner.publicKey.toBytes());
type Call = { method: string; params: unknown[] };
function fixture(v0 = false) {
  const transaction = solanaFixture(v0, true);
  const snapshots = JSON.parse(transaction.snapshots) as { owner: string; dataBase64: string }[];
  const calls: Call[] = [];
  const results: Record<string, unknown> = {
    getGenesisHash: SOLANA_GENESIS.devnet,
    getMultipleAccounts: { context: { slot: 11 }, value: snapshots.map((item) => ({ executable: false, owner: item.owner, data: [item.dataBase64, 'base64'] })) },
    getFeeForMessage: { context: { slot: 12 }, value: 10000 },
    simulateTransaction: { context: { slot: 13 }, value: { err: null, unitsConsumed: 450, logs: ['Program success'] } },
  };
  const fetcher: typeof fetch = async (_url, options) => {
    const request = JSON.parse(options!.body as string) as Call & { id: number };
    calls.push(request);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }));
  };
  const input = { source: base64.encode(transaction.bytes), publicKeyHex, network: 'devnet', encoding: 'base64', format: 'transaction' };
  const read = () => readSolanaRpcContext(endpoint, input, new AbortController().signal, fetcher);
  return { transaction, calls, results, fetcher, input, read };
}

for (const v0 of [false, true]) test(`Solana RPC ${v0 ? 'v0 / ALT' : 'legacy'} binds exact bytes, network, slots, fee and simulation to a new review`, async () => {
  const f = fixture(v0), { review } = await f.read();
  assert.equal(review.signable, true); assert.ok(Object.isFrozen(review)); assert.ok(Object.isFrozen(review.rows[0]));
  assert.equal(review.messageHex, bytesToHex(f.transaction.message));
  assert.equal(review.transactionHex, bytesToHex(f.transaction.bytes));
  const fee = f.calls.find((call) => call.method === 'getFeeForMessage')!;
  assert.equal(fee.params[0], base64.encode(f.transaction.message));
  const simulation = f.calls.at(-1)!;
  assert.equal(simulation.method, 'simulateTransaction'); assert.equal(simulation.params[0], base64.encode(f.transaction.bytes));
  assert.deepEqual(simulation.params[1], { encoding: 'base64', commitment: 'confirmed', minContextSlot: 12, sigVerify: false, replaceRecentBlockhash: false });
  assert.ok(review.rows.some(([label, value]) => label === 'RPC 费用（lamports）' && value === '10000'));
  assert.ok(review.rows.some(([, value]) => value === '模拟成功'));
  if (v0) {
    assert.ok(review.rows.some(([label, value]) => label === 'ALT 来源与顺序' && value.includes('RPC 返回账户数据')));
    assert.deepEqual(f.calls[1]!.params, [[f.transaction.table.key.toBase58()], { encoding: 'base64', commitment: 'confirmed' }]);
    assert.deepEqual(fee.params[1], { commitment: 'confirmed', minContextSlot: 11 });
  }
  const device = relayDevice('solana'), pin = new TextEncoder().encode('123456');
  const signed = await executeReviewedTransaction(device.access, review, device.account.slot, pin);
  assert.ok(pin.every((byte) => byte === 0));
  f.transaction.transaction.sign([solanaSigner]);
  assert.deepEqual(base64.decode(signed.output), f.transaction.transaction.serialize());
});

test('Solana RPC checks configured cluster and genesis before sending transaction bytes', async () => {
  const f = fixture();
  await assert.rejects(readSolanaRpcContext({ ...endpoint, network: 'testnet' }, f.input, new AbortController().signal, f.fetcher), /cluster/);
  assert.equal(f.calls.length, 0);
  f.results.getGenesisHash = SOLANA_GENESIS.testnet;
  await assert.rejects(f.read(), /genesis/); assert.deepEqual(f.calls.map((call) => call.method), ['getGenesisHash']);
});

test('Solana RPC captures all input bytes before awaiting remote context', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetcher: typeof fetch = async (url, options) => { await gate; return f.fetcher(url, options); };
  const pending = readSolanaRpcContext(endpoint, f.input, new AbortController().signal, fetcher);
  f.input.source = base64.encode(solanaV1Fixture().bytes); f.input.network = 'testnet';
  release(); const { review } = await pending;
  assert.equal(review.network, 'devnet'); assert.equal(review.transactionHex, bytesToHex(f.transaction.bytes));
  assert.equal(f.calls.at(-1)!.params[0], base64.encode(f.transaction.bytes));
});

test('Solana RPC rejects missing ALT accounts, wrong owners, malformed account data and stale slots', async () => {
  for (const replacement of [
    { context: { slot: 11 }, value: [] }, { context: { slot: 11 }, value: [null] },
    { context: { slot: 11 }, value: [{ executable: true, owner: 'wrong', data: ['AA==', 'base64'] }] },
    { context: { slot: 11 }, value: [{ executable: false, owner: 'wrong', data: ['AA==', 'base64'] }] },
    { context: { slot: 11 }, value: [{ executable: false, owner: 'wrong', data: ['AA==', 'base64+zstd'] }] },
  ]) {
    const f = fixture(true); f.results.getMultipleAccounts = replacement;
    await assert.rejects(f.read()); assert.equal(f.calls.length, 2);
  }
  const f = fixture(true); f.results.getFeeForMessage = { context: { slot: 10 }, value: 5000 };
  await assert.rejects(f.read(), /slot/);
  const stale = fixture(); stale.results.simulateTransaction = { context: { slot: 11 }, value: { err: null } };
  await assert.rejects(stale.read(), /slot/);
});

test('Solana RPC null fees or failed simulation produce a complete read-only review that cannot approve a device input', async () => {
  for (const failure of ['fee', 'simulation']) {
    const f = fixture();
    if (failure === 'fee') f.results.getFeeForMessage = { context: { slot: 12 }, value: null };
    else f.results.simulateTransaction = { context: { slot: 13 }, value: { err: { InstructionError: [0, 'InsufficientFunds'] }, logs: ['failure'] } };
    const result = await f.read(); assert.equal(result.review.signable, false);
    assert.ok(result.review.rows.some(([label]) => label === 'RPC 模拟结果'));
    assert.throws(() => approveSolanaTransaction(result.review, relayDevice('solana').account.slot));
  }
});

test('Successful RPC simulation cannot grant approval to an unknown instruction or a cloned review', async () => {
  const f = fixture();
  const unknown = solanaFixture(false, false, [new TransactionInstruction({ programId: solanaOther.publicKey, keys: [], data: Buffer.of(1) })]);
  f.input.source = base64.encode(unknown.bytes);
  const { review, expiresAt } = await f.read();
  assert.equal(review.signable, false);
  assert.throws(() => approveSolanaTransaction(review, relayDevice('solana').account.slot));
  assert.throws(() => withSolanaRpcContext({ ...review, signable: true }, {
    transactionHex: review.transactionHex, network: 'devnet', expiresAt, accepted: true, rows: [],
  }));
});

test('Solana RPC refuses unsafe numeric values and malformed simulation logs/results', async () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '5000']) {
    const f = fixture(); f.results.getFeeForMessage = { context: { slot: 12 }, value };
    await assert.rejects(f.read(), /整数/);
  }
  for (const value of [{}, { err: [] }, { err: 0 }, { err: null, logs: [1] }, { err: null, logs: Array(129).fill('x') },
    { err: null, logs: ['x'.repeat(4097)] }, { err: null, unitsConsumed: -1 }]) {
    const f = fixture(); f.results.simulateTransaction = { context: { slot: 13 }, value };
    await assert.rejects(f.read());
  }
});

test('Solana RPC v1 simulation retains the 0x81 envelope and escaping keeps untrusted log controls visible', async () => {
  const f = fixture(), v1 = solanaV1Fixture(true);
  f.input.source = base64.encode(v1.bytes);
  f.results.simulateTransaction = { context: { slot: 13 }, value: { err: null, logs: ['<script>\u202ehidden\n'] } };
  const { review } = await f.read(); assert.equal(review.version, 'v1');
  assert.equal(f.calls.at(-1)!.params[0], base64.encode(v1.bytes));
  assert.ok(review.rows.some(([label, value]) => label === 'RPC 模拟日志 0' && value.includes('\\u202e') && value.includes('\\n')));
});

test('Solana RPC context binds transaction/network and expires before a PIN can reach the device', async (context) => {
  const f = fixture(), result = await f.read();
  const base = prepareSolanaTransaction(f.input.source, publicKeyHex, 'devnet');
  for (const override of [{ transactionHex: '00' }, { network: 'testnet' }, { expiresAt: Date.now() + 1200000 }]) {
    assert.throws(() => withSolanaRpcContext(base, { transactionHex: base.transactionHex, network: 'devnet', expiresAt: result.expiresAt, accepted: true, rows: [], ...override }));
  }
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() }); context.mock.timers.tick(120001);
  const device = relayDevice('solana'), pin = new TextEncoder().encode('123456');
  await assert.rejects(executeReviewedTransaction(device.access, result.review, device.account.slot, pin), /过期/);
  assert.equal(device.counts().tasks, 0); assert.ok(pin.every((byte) => byte === 0));
});

test('Solana RPC expiry during touch discards a late hardware signature', async (context) => {
  const f = fixture(), result = await f.read(), device = relayDevice('solana');
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const sign = device.access.sign.bind(device.access);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let touched!: () => void;
  const waiting = new Promise<void>((resolve) => { touched = resolve; });
  device.access.sign = (operation) => sign((transport, signal) => operation({ exchange: async (command) => {
    if (command[1] === 0x2a) { touched(); await gate; }
    return transport.exchange(command);
  } }, signal));
  const pending = executeReviewedTransaction(device.access, result.review, device.account.slot, new TextEncoder().encode('123456'));
  await waiting; context.mock.timers.tick(120001); release();
  await assert.rejects(pending, /过期/); assert.equal(device.counts().signatures, 1);
});
