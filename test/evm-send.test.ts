import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction } from 'micro-eth-signer';
import { readWalletRpcRequest } from '../src/connectors/walletconnect/rpc';
import { walletTransactionSources, sessionNamespaces } from '../src/connectors/walletconnect/policy';
import { relayDevice } from './fixtures/relay-device';
import { walletRpcFixture } from './fixtures/wallet-rpc';
import { isConformingNamespaces } from '@walletconnect/utils';
import { accountForWalletRequest } from '../src/connectors/walletconnect/policy';

function fixture(fields: Record<string, unknown> = {}) {
  const device = relayDevice('evm'), rpc = walletRpcFixture('evm');
  const account = { ...device.account, network: '31337', chainId: 'eip155:31337' };
  const params = [{ from: account.address, to: '0x0000000000000000000000000000000000000001', ...fields }];
  rpc.results.eth_maxPriorityFeePerGas = '0x1'; rpc.results.eth_gasPrice = '0x2';
  const read = () => readWalletRpcRequest(account, 'eth_sendTransaction', params, rpc.endpoint, new AbortController().signal, rpc.fetcher);
  return { ...rpc, device, account, params, read };
}

test('EVM send resolves a normal minimal dApp request into an exact chain-bound transaction and itemizes every default', async () => {
  const f = fixture();
  const granted = sessionNamespaces({ requiredNamespaces: { eip155: { chains: [f.account.chainId], methods: ['eth_sendTransaction'], events: [] } }, optionalNamespaces: {} }, f.account);
  assert.deepEqual(granted.eip155!.methods, ['eth_sendTransaction']);
  const result = await f.read(), review = result.reviews[0]!;
  assert.equal(review.chain, 'evm'); assert.ok(review.signable);
  assert.ok('unsignedHex' in review);
  const tx = Transaction.fromHex(review.unsignedHex);
  assert.equal(tx.type, 'eip1559'); assert.equal(tx.raw.chainId, 31337n); assert.equal(tx.raw.nonce, 0n);
  assert.equal(tx.raw.gasLimit, 21000n); assert.equal(tx.raw.value, 0n);
  assert.equal('maxFeePerGas' in tx.raw && tx.raw.maxFeePerGas, 3n);
  assert.equal('maxPriorityFeePerGas' in tx.raw && tx.raw.maxPriorityFeePerGas, 1n);
  for (const key of ['type', 'nonce', 'gasLimit', 'value', 'data', 'accessList', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    assert.ok(review.rows.some(([label]) => label === `请求补全 ${key}`), key);
  }
  const estimate = f.calls.find((call) => call.method === 'eth_estimateGas')!;
  assert.equal(estimate.params[1], 'pending'); assert.equal(Object.hasOwn(estimate.params[0] as object, 'gas'), false);
  assert.equal(f.device.counts().signatures, 0);
});

test('EVM namespace authorization accepts requested chains independently of RPC availability', () => {
  const f = fixture(), automatic = { ...f.account, network: '', chainId: '' };
  const required = { requiredNamespaces: { eip155: { chains: ['eip155:1'], methods: ['eth_sendTransaction'], events: [] } }, optionalNamespaces: {} };
  const available = (chain: string) => chain === 'eip155:1';
  assert.deepEqual(sessionNamespaces(required, automatic, available).eip155!.methods, ['eth_sendTransaction']);
  assert.deepEqual(sessionNamespaces(required, automatic, () => false).eip155!.methods, ['eth_sendTransaction']);
  const mixed = { chains: ['eip155:1', 'eip155:8453'], methods: ['eth_signTransaction', 'eth_sendTransaction'], events: [] };
  assert.deepEqual(sessionNamespaces({ requiredNamespaces: { eip155: mixed }, optionalNamespaces: {} }, automatic, available).eip155!.chains, mixed.chains);
  assert.deepEqual(sessionNamespaces({ requiredNamespaces: {}, optionalNamespaces: { eip155: mixed } }, automatic, available).eip155!.methods, mixed.methods);
});

test('Merged EVM chain permissions conform to the proposal while send availability is checked per request', () => {
  const f = fixture(), account = { ...f.account, network: '', chainId: '' };
  const required = { eip155: { chains: ['eip155:1'], methods: ['eth_sendTransaction'], events: [] } };
  const optional = { eip155: { chains: ['eip155:8453'], methods: ['eth_signTransaction'], events: [] } };
  const available = (chain: string) => chain === 'eip155:1';
  for (const proposal of [{ requiredNamespaces: required, optionalNamespaces: optional },
    { requiredNamespaces: {}, optionalNamespaces: { eip155: { chains: ['eip155:1', 'eip155:8453'], methods: ['eth_sendTransaction', 'eth_signTransaction'], events: [] } } }]) {
    const granted = sessionNamespaces(proposal, account, available);
    assert.equal(isConformingNamespaces(proposal.requiredNamespaces, granted, 'send permissions'), null);
    assert.equal(accountForWalletRequest(account, granted, 'eip155:1', 'eth_sendTransaction').network, '1');
    assert.equal(accountForWalletRequest(account, granted, 'eip155:8453', 'eth_signTransaction').network, '8453');
    assert.equal(accountForWalletRequest(account, granted, 'eip155:8453', 'eth_sendTransaction').network, '8453');
  }
});

test('EVM send retains supplied fields, accepts input alias once and never refreshes supplied fees or nonce', async () => {
  const f = fixture({ type: '0x2', chainId: '0x7a69', nonce: '0x0', gas: '0x5208', value: '0x7', input: '0x',
    maxFeePerGas: '0x9', maxPriorityFeePerGas: '0x2', accessList: [] });
  const result = await f.read(), review = result.reviews[0]!;
  assert.ok('unsignedHex' in review);
  const tx = Transaction.fromHex(review.unsignedHex);
  assert.equal(tx.raw.value, 7n); assert.equal(tx.raw.gasLimit, 21000n);
  assert.equal('maxFeePerGas' in tx.raw && tx.raw.maxFeePerGas, 9n);
  assert.ok(!review.rows.some(([label]) => label.startsWith('请求补全 ')));
  assert.ok(!f.calls.some((call) => ['eth_gasPrice', 'eth_maxPriorityFeePerGas'].includes(call.method)));
  for (const fields of [{ gas: '0x5208', gasLimit: '21000' }, { input: '0x', data: '0x' }, { from: '0x' + '11'.repeat(20) }, { extra: true }]) {
    assert.throws(() => walletTransactionSources(f.account, 'eth_sendTransaction', [{ ...f.params[0], ...fields }]));
  }
});

test('EVM send chooses legacy or access-list fees on a pre-baseFee network and honors explicit type 0/1', async () => {
  for (const fields of [{}, { accessList: [] }, { type: '0' }, { type: '1' }]) {
    const f = fixture(fields);
    delete (f.results.eth_getBlockByNumber as Record<string, unknown>).baseFeePerGas;
    const result = await f.read(), review = result.reviews[0]!;
    assert.ok('unsignedHex' in review);
    const tx = Transaction.fromHex(review.unsignedHex);
    assert.equal(tx.type, fields.type === '1' || Object.hasOwn(fields, 'accessList') ? 'eip2930' : 'legacy');
    assert.equal('gasPrice' in tx.raw && tx.raw.gasPrice, 2n);
    assert.ok(!f.calls.some((call) => call.method === 'eth_maxPriorityFeePerGas'));
  }
});

test('EVM send fills partial fee requests while refusing contradictions, invalid fields, unsupported calls and transaction types', async () => {
  for (const fields of [{ maxFeePerGas: '9' }, { maxPriorityFeePerGas: '2' }]) {
    const f = fixture(fields), result = await f.read();
    assert.ok(result.reviews[0]!.signable);
  }
  for (const fields of [{ gasPrice: '2', maxFeePerGas: '3' }, { type: '2', nonce: 0 }, { type: '99' }, { chainId: '1' },
    { type: '4' }, { type: '0x4' }, { authorizationList: [] }, { data: '0x12345678' }, { to: '0x' }, { maxFeePerGas: '0', maxPriorityFeePerGas: '1' }]) {
    const f = fixture(fields); await assert.rejects(f.read());
    assert.equal(f.device.counts().signatures, 0);
  }
});

test('EVM send rejects an unfillable dynamic fee network', async () => {
  const failed = fixture({ type: '2' }); delete (failed.results.eth_getBlockByNumber as Record<string, unknown>).baseFeePerGas;
  await assert.rejects(failed.read(), /baseFee/);
});

test('EVM send fails closed on the selected network, RPC errors, invalid quantities and elapsed preparation', async (context) => {
  const wrong = fixture(); wrong.results.eth_chainId = '0x1';
  await assert.rejects(wrong.read()); assert.equal(wrong.calls.length, 1);
  const fee = fixture(); fee.results.eth_maxPriorityFeePerGas = '0x01';
  await assert.rejects(fee.read());
  const failed = fixture(); failed.results.eth_estimateGas = '0x0';
  await assert.rejects(failed.read());
  const expired = fixture();
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await assert.rejects(readWalletRpcRequest(expired.account, 'eth_sendTransaction', expired.params, expired.endpoint, new AbortController().signal,
    async (url, options) => { context.mock.timers.tick(15000); return expired.fetcher(url, options); }));
});
