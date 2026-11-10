import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction } from 'micro-eth-signer';
import { readEvmRpcContext, evmRpcQuantity } from '../src/network/evm';
import { evmRpcEndpoints, networkPolicyHtml } from '../src/network/config';
import { prepareEvmTransaction, withEvmRpcContext } from '../src/chains/evm/transaction';
import { executeReviewedTransaction } from '../src/signing/execute';
import { approveEvmTransaction } from '../src/signing/approval';
import { relayDevice } from './fixtures/relay-device';
import { tokenTransactionInput, tokenCallVectors, encodeTokenCall } from './fixtures/evm-calldata';

const endpoint = evmRpcEndpoints()[0]!, device = relayDevice('evm');
const initial = { type: '2', chainId: '1', nonce: '7', gasLimit: '21000', value: '17',
  to: '0x0000000000000000000000000000000000000001', data: '0x', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', accessList: [] };
type Call = { method: string; params: unknown[] };
function fixture(transaction: unknown = initial) {
  const input = { source: JSON.stringify(transaction), publicKeyHex: device.account.publicKeyHex };
  const calls: Call[] = [];
  const header = { number: '0x64', hash: '0x' + 'ab'.repeat(32), timestamp: '0x1234', gasLimit: '0x1c9c380', baseFeePerGas: '0x3b9aca00' };
  const results: Record<string, unknown> = { eth_chainId: '0x1', eth_getBalance: '0x' + 'f'.repeat(64),
    eth_getCode: '0x', eth_call: '0x', eth_estimateGas: '0x5208', eth_getTransactionCount: '0x7', eth_getBlockByNumber: header };
  const errors: Record<string, number> = {};
  let handler: ((call: Call) => unknown) | undefined;
  const fetcher: typeof fetch = async (_url, options) => {
    const call = JSON.parse(options!.body as string) as Call & { id: number }; calls.push(call);
    if (Object.hasOwn(errors, call.method)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: errors[call.method], message: 'untrusted RPC response' } }));
    const value = handler ? handler(call) : results[call.method];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: value }));
  };
  const read = () => readEvmRpcContext(endpoint, input, new AbortController().signal, fetcher);
  return { input, calls, header, results, errors, fetcher, read, setHandler: (value: typeof handler) => { handler = value; } };
}

test('EVM RPC configuration binds decimal chain IDs and grants CSP only the configured origins', () => {
  assert.deepEqual(evmRpcEndpoints().map((endpoint) => endpoint.chainId), ['1', '8453', '42161', '56', '5042']); assert.deepEqual(evmRpcEndpoints('[]'), []);
  const endpoints = evmRpcEndpoints(JSON.stringify([{ name: 'RPC', url: 'http://localhost:8545', chainId: '31337' }]));
  assert.ok(Object.isFrozen(endpoints[0])); assert.equal(endpoints[0]!.chainId, '31337');
  for (const chainId of ['0', '01', '0x1', '1.0', ((1n << 256n)).toString()]) assert.throws(() => evmRpcEndpoints(JSON.stringify([{ ...endpoint, chainId }])));
  for (const value of [[endpoint, endpoint], Array(33).fill(endpoint), [{ ...endpoint, network: 'devnet' }],
    [{ ...endpoint, url: 'http://untrusted.example' }], [{ ...endpoint, url: 'https://user:password@example.org' }], [{ ...endpoint, name: '' }]]) {
    assert.throws(() => evmRpcEndpoints(JSON.stringify(value)));
  }
  const html = 'connect-src wss://relay.walletconnect.org;';
  assert.equal(networkPolicyHtml(html, false, endpoints), 'connect-src wss://relay.walletconnect.org http://localhost:8545;');
  assert.equal(networkPolicyHtml(html, true, endpoints), "connect-src 'none';");
});

test('EVM RPC quantities retain bigint precision and refuse noncanonical or unbounded values', () => {
  assert.equal(evmRpcQuantity('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'), (1n << 256n) - 1n);
  for (const value of ['0x', '0x00', '0x01', '1', 1, '-1', '0x' + 'f'.repeat(65)]) assert.throws(() => evmRpcQuantity(value));
});

for (const type of ['0', '1', '2']) test(`EVM RPC type ${type} preserves the entire reviewed transaction and signs through OpenPGP`, async () => {
  const input = type === '2' ? initial : { type, chainId: '1', nonce: '7', gasLimit: '21000', value: '17', to: initial.to, data: '0x', gasPrice: '2000000000', ...(type === '1' ? { accessList: [] } : {}) };
  const f = fixture(input);
  const { review } = await f.read(), base = prepareEvmTransaction(f.input.source, device.account.publicKeyHex);
  assert.equal(review.signable, true); assert.ok(Object.isFrozen(review.rows[0]));
  assert.equal(review.unsignedHex, base.unsignedHex); assert.equal(review.digestHex, base.digestHex);
  const call = f.calls.find((item) => item.method === 'eth_call')!;
  const tx = call.params[0] as Record<string, unknown>;
  assert.equal(call.params[1], '0x64'); assert.equal(tx.type, `0x${type}`);
  assert.equal(tx.from, base.sender); assert.equal(tx.nonce, '0x7'); assert.equal(tx.data, '0x');
  assert.ok(!Object.hasOwn(tx, 'stateOverride')); assert.ok(!Object.hasOwn(tx, 'r'));
  for (const request of f.calls.filter((item) => ['eth_getBalance', 'eth_getCode'].includes(item.method))) assert.equal(request.params[1], '0x64');
  const pin = new TextEncoder().encode('123456');
  const result = await executeReviewedTransaction(device.access, review, device.account.slot, pin);
  assert.ok(pin.every((byte) => byte === 0)); assert.equal(result.authenticationCleared, true);
  const signed = Transaction.fromHex(result.output); assert.ok(signed.verifySignature());
  assert.equal(signed.toHex({ includeSignature: false }), base.unsignedHex);
});

test('EVM RPC network mismatch stops before address, transaction or calldata disclosure', async () => {
  const f = fixture();
  await assert.rejects(readEvmRpcContext({ ...endpoint, chainId: '10' }, f.input, new AbortController().signal, f.fetcher));
  assert.equal(f.calls.length, 0);
  f.results.eth_chainId = '0xa'; await assert.rejects(f.read(), /chainId/);
  assert.deepEqual(f.calls.map((call) => call.method), ['eth_chainId']);
});

test('EVM RPC wrong nonce, insufficient funds, fee/gas limits and failed execution remain read-only', async () => {
  for (const change of ['nonce', 'balance', 'baseFee', 'gasLimit', 'estimate', 'call-error', 'estimate-error']) {
    const f = fixture();
    if (change === 'nonce') f.results.eth_getTransactionCount = '0x8';
    if (change === 'balance') f.results.eth_getBalance = '0x0';
    if (change === 'baseFee') f.header.baseFeePerGas = '0xffffffffffff';
    if (change === 'gasLimit') f.header.gasLimit = '0x5207';
    if (change === 'estimate') f.results.eth_estimateGas = '0x5209';
    if (change === 'call-error') f.errors.eth_call = 3;
    if (change === 'estimate-error') f.errors.eth_estimateGas = -32000;
    const { review } = await f.read(); assert.equal(review.signable, false, change);
    assert.ok(review.rows.some(([label]) => label === 'RPC 签名策略'));
    assert.throws(() => approveEvmTransaction(review, device.account.slot));
  }
});

test('EVM RPC detects block replacement, endpoint chain changes and backward pending nonces', async () => {
  for (const change of ['block', 'chain', 'nonce']) {
    const f = fixture();
    f.setHandler((call) => {
      if (change === 'block' && call.method === 'eth_getBlockByNumber' && call.params[0] === '0x64') return { ...f.header, hash: '0x' + 'cd'.repeat(32) };
      if (change === 'chain' && call.method === 'eth_chainId' && f.calls.length > 1) return '0x2';
      if (change === 'nonce' && call.method === 'eth_getTransactionCount' && call.params[1] === 'pending') return '0x6';
      return f.results[call.method];
    });
    await assert.rejects(f.read());
  }
});

test('EVM RPC invalid result shapes and oversized byte arrays cannot become trusted context', async () => {
  for (const [method, value] of [['eth_getBalance', '0x00'], ['eth_getTransactionCount', 7], ['eth_getBlockByNumber', null],
    ['eth_getCode', '0x1'], ['eth_call', '0x' + 'aa'.repeat(16385)], ['eth_estimateGas', '0x0']]) {
    const f = fixture(); f.results[method as string] = value;
    await assert.rejects(f.read());
  }
});

test('EVM RPC token calldata is unchanged and a successful call cannot approve unknown selectors', async () => {
  const vector = tokenCallVectors[0]!, calldata = encodeTokenCall(vector.signature, vector.args);
  const f = fixture({ ...tokenTransactionInput(calldata), chainId: '1', nonce: '7' });
  const { review } = await f.read(); assert.equal(review.signable, true);
  assert.equal((f.calls.find((call) => call.method === 'eth_call')!.params[0] as Record<string, unknown>).data, calldata);
  const unknown = fixture({ ...initial, data: '0xdeadbeef' });
  assert.equal((await unknown.read()).review.signable, false);
});

test('EVM RPC captures input before async reads and expires before PIN verification or late signature attachment', async (context) => {
  const f = fixture(), baseSource = f.input.source;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = readEvmRpcContext(endpoint, f.input, new AbortController().signal, async (url, options) => { await gate; return f.fetcher(url, options); });
  f.input.source = JSON.stringify({ ...initial, value: '999' }); release();
  const result = await pending, base = prepareEvmTransaction(baseSource, device.account.publicKeyHex);
  assert.equal(result.review.unsignedHex, base.unsignedHex);
  assert.throws(() => withEvmRpcContext({ ...base }, { unsignedHex: base.unsignedHex, chainId: '1', expiresAt: result.expiresAt, accepted: true, rows: [] }));
  const isolated = relayDevice('evm'), sign = isolated.access.sign.bind(isolated.access);
  let touch!: () => void, finish!: () => void;
  const touched = new Promise<void>((resolve) => { touch = resolve; }), wait = new Promise<void>((resolve) => { finish = resolve; });
  isolated.access.sign = (operation) => sign((transport, signal) => operation({ exchange: async (command) => {
    if (command[1] === 0x88) { touch(); await wait; }
    return transport.exchange(command);
  } }, signal));
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const signing = executeReviewedTransaction(isolated.access, result.review, isolated.account.slot, new TextEncoder().encode('123456'));
  await touched; context.mock.timers.tick(120001); finish(); await assert.rejects(signing, /过期/);
  const before = isolated.counts().tasks, pin = new TextEncoder().encode('123456');
  await assert.rejects(executeReviewedTransaction(isolated.access, result.review, isolated.account.slot, pin), /过期/);
  assert.equal(isolated.counts().tasks, before); assert.ok(pin.every((byte) => byte === 0));
});
