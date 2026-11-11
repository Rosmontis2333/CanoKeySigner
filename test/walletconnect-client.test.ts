import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type SignClient from '@walletconnect/sign-client';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createWalletConnection, WALLETCONNECT_PROJECT_ID } from '../src/connectors/walletconnect/client';
import type { WalletSubmission } from '../src/connectors/walletconnect/client';
import type { DeviceAccess, Review } from '../src/signing/execute';
import { accountAddresses, accountChain } from '../src/ui/accounts';
import type { WalletAccount } from '../src/ui/accounts';
import type { ApduTransport } from '../src/device/apdu';
import { Transaction, eip191Signer, verifyTyped } from 'micro-eth-signer';
import { etherMail } from './fixtures/evm-message';
import { tokenCallVectors, encodeTokenCall, tokenTransactionInput } from './fixtures/evm-calldata';
import { relayDevice } from './fixtures/relay-device';
import { offchainMessageFixture } from './fixtures/solana-message';
import { base58, base64 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { solanaFixture, solanaSigner, solanaOther, solanaDestination } from './fixtures/solana';
import { VersionedTransaction, TransactionInstruction, PublicKey, TransactionMessage, SystemProgram } from '@solana/web3.js';
import { decodeSolanaEnvelope } from '../src/chains/solana/transaction';
import { token2022Instruction, token2022Vectors } from './fixtures/token2022';
import { solanaV1Fixture, encodeV1Fixture } from './fixtures/solana-v1';
import { getTransactionDecoder } from '@solana/transactions';
import { walletRpcFixture } from './fixtures/wallet-rpc';

Object.defineProperty(globalThis, '__WALLETCONNECT__', { value: true, configurable: true });
Object.defineProperty(globalThis, 'window', { value: { location: { origin: 'http://localhost:4173' } }, configurable: true });
const secret = new Uint8Array(32).fill(1);
const publicKeyHex = bytesToHex(secp256k1.getPublicKey(secret, false));
const slot = { slot: 'AUT', algorithm: 'secp256k1', publicKeyHex, algorithmHex: '132b8104000a', uifHex: '0120' } as const;
const address = accountAddresses('evm', slot, '31337')[0]!.address;
const account: WalletAccount = { coin: 'evm', network: '31337', chainId: 'eip155:31337', publicKeyHex, address, slot };
const topic = 'a'.repeat(64), uri = `wc:${topic}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const currentTime = () => Math.floor(Date.now() / 1000);
function tlv(tag: number, data: Uint8Array): Uint8Array {
  return Uint8Array.from([...(tag > 255 ? [tag >> 8, tag & 255] : [tag]), 0x82, data.length >> 8, data.length & 255, ...data]);
}
const transport: ApduTransport = { async exchange(command) {
  let data: Uint8Array = new Uint8Array();
  if (command[1] === 0xca && command[2] === 0) {
    const attributes = Uint8Array.from([
      ...tlv(0xc1, Uint8Array.of(0x13, 0x2b, 0x81, 4, 0, 0x0a)),
      ...tlv(0xc3, Uint8Array.of(0x13, 0x2b, 0x81, 4, 0, 0x0a)),
      ...tlv(0xc4, Uint8Array.of(0, 64, 64, 64, 3, 3, 3)),
      ...tlv(0xd6, Uint8Array.of(1, 0x20)), ...tlv(0xd8, Uint8Array.of(1, 0x20)),
    ]);
    data = tlv(0x6e, tlv(0x73, attributes));
  } else if (command[1] === 0xca) data = Uint8Array.of(0);
  else if (command[1] === 0x47) data = tlv(0x7f49, tlv(0x86, secp256k1.getPublicKey(secret, false)));
  else if (command[1] === 0x88) data = Uint8Array.from(secp256k1.sign(command.slice(5, 37), secret, { prehash: false }));
  return Uint8Array.from([...data, 0x90, 0]);
} };
function fixture(methods = ['eth_signTransaction'], current = account, chains = [current.chainId], deviceAccess?: DeviceAccess, rpcSupport = false, canSubmit?: (chainId: string) => boolean, events: string[] = []) {
  const namespace = current.coin === 'evm' ? 'eip155' : current.chainId.split(':')[0]!;
  const client = new EventEmitter() as EventEmitter & {
    session: { getAll(): unknown[] }; core: { pairing: { disconnect: (args: unknown) => Promise<void> } };
    pair: (args: unknown) => Promise<void>; approve: (args: unknown) => Promise<unknown>;
    disconnect: (args: unknown) => Promise<void>; reject: (args: unknown) => Promise<void>; respond: (args: unknown) => Promise<void>;
  };
  const statuses: string[] = [];
  const responses: { topic: string; response: { id: number; result?: unknown; error?: { message: string; data?: string } } }[] = [];
  const emitted: unknown[] = [];
  const dispatch = client.emit.bind(client);
  client.emit = ((event: string | symbol | object, ...args: unknown[]) => {
    if (typeof event === 'object') { emitted.push(event); return Promise.resolve(); }
    return dispatch(event, ...args);
  }) as typeof client.emit;
  const disconnected: unknown[] = [], rejected: unknown[] = [], pairs: unknown[] = [], approved: unknown[] = [];
  const session = { topic, expiry: currentTime() + 3600, namespaces: { [namespace]: { chains, accounts: chains.map((chain) => `${chain}:${current.address}`), methods, events } }, peer: { metadata: { name: 'Test dApp' } } };
  client.session = { getAll: () => [] }; client.core = { pairing: { disconnect: async () => undefined } };
  client.pair = async (args) => { pairs.push(args); };
  client.approve = async (args) => { approved.push(args); return { acknowledged: async () => session }; };
  client.disconnect = async (args) => { disconnected.push(args); };
  client.reject = async (args) => { rejected.push(args); };
  client.respond = async (args) => { responses.push(args as typeof responses[number]); };
  let signCount = 0, proposalCount = 0, reviewCount = 0, cancellations = 0, resetCount = 0, clearCount = 0;
  let snapshots = '[]';
  const reviews: { review: Review; method: string; batch: { index: number; total: number } | undefined }[] = [];
  const contextRequests: { account: WalletAccount; method: string; paramsJson: string }[] = [];
  const rpcStates: { available: boolean; busy: boolean; signable: boolean; checks: readonly Review[] }[] = [];
  const submissions: (WalletSubmission | undefined)[] = [];
  const access: DeviceAccess = { slots: () => [current.slot], busy: () => false, cancel: () => { cancellations++; deviceAccess?.cancel(); }, requireReinsert: () => { resetCount++; deviceAccess?.requireReinsert(); },
    async sign(operation) { signCount++; return deviceAccess ? deviceAccess.sign(operation) : operation(transport, new AbortController().signal); } };
  const wallet = createWalletConnection(access, {
    ...(canSubmit ? { canSubmit } : {}),
    account: () => current, snapshots: () => snapshots, clear: () => { clearCount++; }, status: (text) => { statuses.push(text); },
    proposal: () => { proposalCount++; }, request: (review, method, batch) => { reviewCount++; reviews.push({ review, method, batch }); },
    ...(rpcSupport ? { contextRequired: (account: WalletAccount, method: string, paramsJson: string) => { contextRequests.push({ account, method, paramsJson }); } } : {}),
    rpc: (_account, available, busy, signable, checks) => { rpcStates.push({ available, busy, signable, checks }); },
    submission: (record) => { submissions.push(record); },
  }, async (options) => { initializations.push(options); return client as unknown as SignClient; });
  const initializations: unknown[] = [];
  function proposal(pairingTopic = topic) { client.emit('session_proposal', { id: 1, params: { id: 1, expiryTimestamp: currentTime() + 300, pairingTopic,
    requiredNamespaces: { [namespace]: { chains, methods, events } }, optionalNamespaces: {} } }); }
  function request(id = 2, options: { chainId?: string; topic?: string; expiry?: number; method?: string; params?: unknown } = {}) {
    client.emit('session_request', { id, topic: options.topic ?? topic, params: { chainId: options.chainId ?? current.chainId, request: { method: options.method ?? 'eth_signTransaction',
      expiryTimestamp: options.expiry ?? currentTime() + 300,
      params: options.params ?? [{ type: '0x2', chainId: '0x7a69', nonce: '0x0', gas: '0x5208', from: address,
        to: '0x0000000000000000000000000000000000000001', value: '0x0', data: '0x', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', accessList: [] }] } } });
  }
  async function connect() { await wallet.pair(uri); proposal(); await flush(); await wallet.approve(); }
  return { wallet, client, access, responses, disconnected, rejected, pairs, approved, initializations, session, proposal, request, connect, reviews, contextRequests, rpcStates,
    submissions, statuses, emitted, setSnapshots: (value: string) => { snapshots = value; },
    counts: () => ({ signCount, proposalCount, reviewCount, cancellations, resetCount, clearCount }) };
}

test('WalletConnect only signs after explicit proposal and transaction confirmation, verifies and returns signed transaction', async () => {
  const f = fixture(); await f.connect();
  assert.equal(f.counts().proposalCount, 1);
  assert.equal(f.approved.length, 1);
  f.request(); await flush();
  assert.equal(f.counts().signCount, 0); assert.equal(f.counts().reviewCount, 1);
  const pin = new TextEncoder().encode('123456');
  await f.wallet.sign(pin);
  assert.ok(pin.every((byte) => byte === 0));
  const tx = Transaction.fromHex(f.responses[0]!.response.result as string);
  assert.equal(tx.sender, address); assert.equal(tx.verifySignature(), true);
  assert.equal(f.counts().signCount, 1);
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  f.wallet.invalidate();
});

test('duplicate, concurrent, wrong-topic, wrong-chain and expired requests never trigger device signing', async () => {
  const f = fixture(); await f.connect();
  f.request(); f.request(); f.request(3); f.request(4, { topic: 'wrong' }); f.request(5, { chainId: 'eip155:1' });
  await flush();
  assert.equal(f.counts().reviewCount, 1); assert.equal(f.counts().signCount, 0);
  assert.equal(f.responses.length, 3);
  await f.wallet.reject();
  f.request(6, { expiry: currentTime() - 1 }); await flush();
  assert.equal(f.responses.at(-1)!.response.id, 6); assert.ok(f.responses.at(-1)!.response.error);
  f.wallet.invalidate();
});

test('changed account disconnects session, rejects pending request and invalidates later confirmation', async () => {
  const f = fixture(); await f.connect(); f.request(); await flush();
  f.wallet.invalidate(); await flush();
  assert.equal(f.disconnected.length, 1); assert.ok(f.responses[0]!.response.error);
  const pin = new TextEncoder().encode('123456'); await assert.rejects(f.wallet.sign(pin));
  assert.ok(pin.every((byte) => byte === 0)); assert.equal(f.counts().signCount, 0);
});

test('WalletConnect standard token requests require individual reviews and return the exact approved calldata', async () => {
  const f = fixture(); await f.connect();
  for (const [index, vector] of tokenCallVectors.entries()) {
    const data = encodeTokenCall(vector.signature, vector.args);
    f.request(2 + index, { params: [{ ...tokenTransactionInput(data), from: address }] }); await flush();
    assert.equal(f.counts().reviewCount, index + 1);
    assert.equal(f.counts().signCount, index);
    await f.wallet.sign(new TextEncoder().encode('123456'));
    const transaction = Transaction.fromHex(f.responses[index]!.response.result as string);
    assert.equal(transaction.verifySignature(), true);
    assert.equal(transaction.sender, address);
    assert.equal(`0x${transaction.raw.data.replace(/^0x/, '')}`, data);
  }
  const data = encodeTokenCall(tokenCallVectors[0].signature, tokenCallVectors[0].args) + '00';
  f.request(100, { params: [{ ...tokenTransactionInput(data), from: address }] }); await flush();
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(f.counts().signCount, tokenCallVectors.length);
  f.wallet.invalidate();
});

test('WalletConnect Solana signMessage reviews and approves exact offchain bytes, returning a Base58 signature', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signMessage'], device.account, [device.account.chainId], device.access);
  await f.connect();
  for (const version of [0, 1] as const) {
    const bytes = offchainMessageFixture({ version });
    f.request(2 + version, { method: 'solana_signMessage', params: { message: base58.encode(bytes), pubkey: device.account.address } }); await flush();
    assert.equal(f.counts().reviewCount, version + 1);
    assert.equal(f.counts().signCount, version);
    const pin = new TextEncoder().encode('123456');
    await f.wallet.sign(pin);
    assert.ok(pin.every((byte) => byte === 0));
    const result = f.responses[version]!.response.result as { signature: string };
    assert.deepEqual(Object.keys(result), ['signature']);
    assert.equal(ed25519.verify(base58.decode(result.signature), bytes, solanaSigner.publicKey.toBytes(), { zip215: false }), true);
  }
  f.request(5, { method: 'solana_signMessage', params: { message: base58.encode(offchainMessageFixture()), pubkey: 'other' } }); await flush();
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(f.counts().signCount, 2);
  f.wallet.invalidate();
});

test('WalletConnect Solana message account changes and rejection invalidate pending signatures', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signMessage'], device.account, [device.account.chainId], device.access);
  await f.connect();
  const params = { message: base58.encode(offchainMessageFixture()), pubkey: device.account.address };
  f.request(2, { method: 'solana_signMessage', params }); await flush();
  await f.wallet.reject();
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  f.request(3, { method: 'solana_signMessage', params }); await flush();
  f.wallet.invalidate(); await flush();
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(f.counts().signCount, 0);
  assert.ok(f.disconnected.length);
});

test('Solana batch signing requires separate approvals and returns legacy/v0 transactions in original order', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  const fixtures = [solanaFixture(false, true), solanaFixture(true, true)];
  f.setSnapshots(fixtures[1]!.snapshots); await f.connect();
  const params = { transactions: fixtures.map((item) => base64.encode(item.bytes)) };
  f.request(2, { method: 'solana_signAllTransactions', params }); await flush();
  params.transactions.reverse(); // Mutating the source after review cannot change order or bytes.
  assert.deepEqual(f.reviews[0]!.batch, { index: 1, total: 2 });
  assert.equal(device.counts().signatures, 0);
  const cleared = f.counts().clearCount;
  const firstPin = new TextEncoder().encode('123456'); await f.wallet.sign(firstPin);
  assert.ok(firstPin.every((byte) => byte === 0));
  assert.equal(device.counts().signatures, 1); assert.equal(f.responses.length, 0);
  assert.deepEqual(f.reviews[1]!.batch, { index: 2, total: 2 });
  assert.equal(f.counts().clearCount, cleared + 1);
  const nextReview = f.reviews[1]!.review;
  assert.ok(nextReview.chain === 'solana');
  assert.equal(nextReview.messageHex, bytesToHex(fixtures[1]!.message));
  const secondPin = new TextEncoder().encode('123456'); await f.wallet.sign(secondPin);
  assert.ok(secondPin.every((byte) => byte === 0));
  assert.equal(device.counts().signatures, 2); assert.equal(f.responses.length, 1);
  const result = f.responses[0]!.response.result as { transactions: string[] };
  assert.deepEqual(Object.keys(result), ['transactions']); assert.equal(result.transactions.length, 2);
  result.transactions.forEach((encoded, index) => {
    const transaction = VersionedTransaction.deserialize(base64.decode(encoded));
    assert.deepEqual(transaction.message.serialize(), fixtures[index]!.message);
    assert.deepEqual(transaction.signatures[1], fixtures[index]!.transaction.signatures[1]);
    assert.ok(ed25519.verify(transaction.signatures[0]!, fixtures[index]!.message, solanaSigner.publicKey.toBytes(), { zip215: false }));
  });
  assert.equal(device.counts().cleanup, 4);
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  f.wallet.invalidate();
});

test('WalletConnect Token-2022 single and batch requests use the exact shared review and signature policy', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signTransaction', 'solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  const transfer = token2022Vectors.find((item) => item.name === 'transferWithFeeMultisig')!;
  const configuration = token2022Vectors.find((item) => item.name === 'enableMemo')!;
  const fixtures = [solanaFixture(true, true, [token2022Instruction(transfer)]), solanaFixture(false, false, [token2022Instruction(configuration)])];
  f.setSnapshots(fixtures[0]!.snapshots); await f.connect();
  f.request(2, { method: 'solana_signTransaction', params: { transaction: base64.encode(fixtures[0]!.bytes) } }); await flush();
  assert.ok(f.reviews[0]!.review.rows.some(([, value]) => value === transfer.operation));
  assert.ok(f.reviews[0]!.review.rows.some(([, value]) => value === '123'));
  await f.wallet.sign(new TextEncoder().encode('123456'));
  fixtures[0]!.transaction.sign([solanaSigner]);
  assert.equal((f.responses[0]!.response.result as { transaction: string }).transaction, base64.encode(fixtures[0]!.transaction.serialize()));
  f.request(3, { method: 'solana_signAllTransactions', params: { transactions: fixtures.map((item) => base64.encode(item.bytes)) } }); await flush();
  await f.wallet.sign(new TextEncoder().encode('123456'));
  assert.equal(f.responses.length, 1);
  assert.ok(f.reviews.at(-1)!.review.rows.some(([, value]) => value === configuration.operation));
  await f.wallet.sign(new TextEncoder().encode('123456'));
  const batch = f.responses[1]!.response.result as { transactions: string[] };
  fixtures.forEach((item, index) => {
    item.transaction.sign([solanaSigner]);
    assert.equal(batch.transactions[index], base64.encode(item.transaction.serialize()));
  });
  const implicitFee = token2022Vectors.find((item) => item.name === 'transferChecked')!;
  const invalid = solanaFixture(false, false, [token2022Instruction(implicitFee)]);
  f.request(4, { method: 'solana_signTransaction', params: { transaction: base64.encode(invalid.bytes) } }); await flush();
  assert.ok(f.responses.at(-1)!.response.error);
  f.request(5, { method: 'solana_signAllTransactions', params: { transactions: [base64.encode(fixtures[1]!.bytes), base64.encode(invalid.bytes)] } }); await flush();
  assert.ok(f.responses.at(-1)!.response.error);
  assert.equal(device.counts().signatures, 3);
  f.wallet.invalidate();
});

test('WalletConnect v1 signs the prefixed message, returns its tail signature and supports a mixed-version batch', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signTransaction', 'solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  const fixtures = [solanaFixture(false, true), solanaFixture(true, true), solanaV1Fixture(true)] as const;
  f.setSnapshots(fixtures[1]!.snapshots); await f.connect();
  f.request(2, { method: 'solana_signTransaction', params: { transaction: base64.encode(fixtures[2]!.bytes) } }); await flush();
  assert.ok(f.reviews[0]!.review.rows.some(([label, value]) => label === 'v1 Priority fee（总 lamports）' && value === '5000（显式）'));
  await f.wallet.sign(new TextEncoder().encode('123456'));
  const result = f.responses[0]!.response.result as { transaction: string; signature: string };
  const decoded = getTransactionDecoder().decode(base64.decode(result.transaction));
  assert.ok(ed25519.verify(base58.decode(result.signature), fixtures[2]!.message, solanaSigner.publicKey.toBytes(), { zip215: false }));
  assert.deepEqual([...Object.values(decoded.signatures)[0]!], [...base58.decode(result.signature)]);
  f.request(3, { method: 'solana_signAllTransactions', params: { transactions: fixtures.map((item) => base64.encode(item.bytes)) } }); await flush();
  for (let index = 0; index < fixtures.length; index++) {
    assert.deepEqual(f.reviews.at(-1)!.batch, { index: index + 1, total: 3 });
    assert.equal(f.responses.length, 1);
    await f.wallet.sign(new TextEncoder().encode('123456'));
  }
  const batch = f.responses[1]!.response.result as { transactions: string[] };
  batch.transactions.forEach((output, index) => {
    const transaction = getTransactionDecoder().decode(base64.decode(output));
    assert.deepEqual(new Uint8Array(transaction.messageBytes), new Uint8Array(fixtures[index]!.message));
    assert.ok(ed25519.verify(new Uint8Array(Object.values(transaction.signatures)[0]!), fixtures[index]!.message, solanaSigner.publicKey.toBytes(), { zip215: false }));
    const original = getTransactionDecoder().decode(fixtures[index]!.bytes);
    assert.deepEqual([...Object.values(transaction.signatures)[1]!], [...Object.values(original.signatures)[1]!]);
  });
  const memoBase = solanaV1Fixture(false, {}, [new TransactionInstruction({
    programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.alloc(0),
  })]);
  const oversized = encodeV1Fixture({ ...memoBase.compiled,
    instructionHeaders: [{ ...memoBase.compiled.instructionHeaders[0]!, numInstructionDataBytes: 1300 }],
    instructionPayloads: [{ instructionAccountIndices: [], instructionData: new Uint8Array(1300).fill(0x61) }] });
  f.request(4, { method: 'solana_signAllTransactions', params: { transactions: [base64.encode(fixtures[0]!.bytes), base64.encode(oversized.bytes)] } }); await flush();
  assert.ok(f.responses.at(-1)!.response.error); assert.equal(device.counts().signatures, 4);
  f.wallet.invalidate();
});

test('Solana singleton and maximum batches retain array responses and never sign ahead', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  await f.connect();
  let total = 0;
  for (const count of [1, 8]) {
    f.request(2 + count, { method: 'solana_signAllTransactions', params: { transactions: Array(count).fill(base64.encode(solanaFixture().bytes)) } }); await flush();
    for (let index = 0; index < count; index++) {
      assert.equal(device.counts().signatures, total);
      assert.deepEqual(f.reviews.at(-1)!.batch, { index: index + 1, total: count });
      await f.wallet.sign(new TextEncoder().encode('123456')); total++;
    }
    assert.equal((f.responses.at(-1)!.response.result as { transactions: string[] }).transactions.length, count);
  }
  f.wallet.invalidate();
});

test('Solana invalid later batch items fail before the first approval or hardware operation', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  await f.connect();
  f.request(2, { method: 'solana_signAllTransactions', params: { transactions: [base64.encode(solanaFixture().bytes), base64.encode(solanaFixture(true).bytes)] } }); await flush();
  assert.ok(f.responses[0]!.response.error); assert.equal(f.reviews.length, 0);
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(device.counts().signatures, 0); assert.equal(device.counts().tasks, 0);
  f.wallet.invalidate();
});

for (const action of ['reject', 'invalidate', 'expire', 'device-failure'] as const) {
  test(`Solana ${action} after the first batch signature discards the whole batch`, async () => {
    const device = relayDevice('solana');
    const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
    await f.connect();
    const params = { transactions: Array(3).fill(base64.encode(solanaFixture().bytes)) };
    f.request(2, { method: 'solana_signAllTransactions', params }); await flush();
    await f.wallet.sign(new TextEncoder().encode('123456'));
    assert.equal(f.responses.length, 0); assert.equal(f.reviews.length, 2);
    if (action === 'reject') await f.wallet.reject();
    if (action === 'invalidate') f.wallet.invalidate();
    if (action === 'expire') f.client.emit('session_request_expire', { id: 2 });
    if (action === 'device-failure') f.access.sign = async () => { throw new Error('Device disconnected'); };
    await flush();
    const pin = new TextEncoder().encode('123456');
    await assert.rejects(f.wallet.sign(pin)); assert.ok(pin.every((byte) => byte === 0));
    assert.equal(f.responses.length, 1); assert.ok(f.responses[0]!.response.error);
    assert.equal(f.responses[0]!.response.result, undefined);
    assert.equal(device.counts().signatures, 1); assert.equal(f.reviews.length, 2);
    f.wallet.invalidate();
  });
}

test('Solana batch keeps its original deadline across approvals', async (context) => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  await f.connect(); context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  f.request(2, { method: 'solana_signAllTransactions', params: { transactions: Array(2).fill(base64.encode(solanaFixture().bytes)) } }); await flush();
  context.mock.timers.tick(290000);
  await f.wallet.sign(new TextEncoder().encode('123456'));
  assert.equal(f.responses.length, 0);
  context.mock.timers.tick(10001); await flush();
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(device.counts().signatures, 1); assert.ok(f.responses[0]!.response.error);
  f.wallet.invalidate();
});

test('Solana duplicate requests and concurrent confirmations cannot advance a batch twice', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  await f.connect();
  const params = { transactions: Array(2).fill(base64.encode(solanaFixture().bytes)) };
  f.request(2, { method: 'solana_signAllTransactions', params });
  f.request(2, { method: 'solana_signAllTransactions', params });
  f.request(3, { method: 'solana_signAllTransactions', params }); await flush();
  assert.equal(f.reviews.length, 1); assert.equal(f.responses.length, 1);
  const sign = f.access.sign.bind(f.access);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  f.access.sign = async (operation) => { await gate; return sign(operation); };
  const first = f.wallet.sign(new TextEncoder().encode('123456'));
  const duplicatePin = new TextEncoder().encode('123456');
  await assert.rejects(f.wallet.sign(duplicatePin)); assert.ok(duplicatePin.every((byte) => byte === 0));
  resume(); await first;
  assert.equal(device.counts().signatures, 1); assert.equal(f.reviews.length, 2);
  assert.equal(f.responses.length, 1);
  await f.wallet.sign(new TextEncoder().encode('123456'));
  assert.equal(device.counts().signatures, 2); assert.equal(f.responses.length, 2);
  f.wallet.invalidate();
});

test('Solana late batch signature after cancellation cannot produce a partial response or a next review', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  await f.connect();
  f.request(2, { method: 'solana_signAllTransactions', params: { transactions: Array(3).fill(base64.encode(solanaFixture().bytes)) } }); await flush();
  await f.wallet.sign(new TextEncoder().encode('123456'));
  const sign = f.access.sign.bind(f.access);
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { complete = resolve; });
  f.access.sign = async (operation) => {
    const result = await sign(operation); await gate; return result;
  };
  const signing = f.wallet.sign(new TextEncoder().encode('123456')); await flush();
  assert.equal(device.counts().signatures, 2);
  await f.wallet.reject(); complete(); await assert.rejects(signing);
  assert.equal(f.reviews.length, 2); assert.equal(f.responses.length, 1);
  assert.ok(f.responses[0]!.response.error); assert.ok(f.counts().cancellations);
  f.wallet.invalidate();
});

test('Solana batch stops if hardware authentication cleanup fails after a verified signature', async () => {
  const device = relayDevice('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  const sign = device.access.sign.bind(device.access);
  f.access.sign = (operation) => sign((transport, signal) => operation({ exchange: async (command) => {
    if (command[1] === 0x20 && command[2] === 0xff) return Uint8Array.of(0x69, 0x85);
    return transport.exchange(command);
  } }, signal));
  await f.connect();
  f.request(2, { method: 'solana_signAllTransactions', params: { transactions: Array(2).fill(base64.encode(solanaFixture().bytes)) } }); await flush();
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')), /认证状态/);
  assert.equal(device.counts().signatures, 1); assert.equal(f.reviews.length, 1);
  assert.equal(device.counts().blocked, true); assert.ok(f.responses[0]!.response.error);
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(device.counts().signatures, 1);
  f.wallet.invalidate();
});

test('WalletConnect EVM RPC requires a separate read and approval, fixes request bytes and reuses verified signing', async () => {
  const f = fixture(); await f.connect();
  const params = [{ type: '0x2', chainId: '0x7a69', nonce: '0x0', gas: '0x5208', from: address,
    to: '0x0000000000000000000000000000000000000001', value: '0x0', data: '0x', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', accessList: [] }];
  f.request(2, { params }); await flush();
  const rpc = walletRpcFixture('evm'); assert.equal(rpc.calls.length, 0);
  params[0]!.value = '0x55';
  const before = f.counts().clearCount;
  await f.wallet.readRpc(rpc.endpoint, rpc.fetcher);
  assert.ok(f.counts().clearCount > before);
  assert.ok(f.rpcStates.some((state) => state.busy && !state.signable));
  assert.equal(f.rpcStates.at(-1)!.signable, true);
  assert.ok(f.reviews.at(-1)!.review.rows.some(([label]) => label === 'RPC chainId 核对'));
  const call = rpc.calls.find((item) => item.method === 'eth_call')!;
  assert.equal((call.params[0] as { value: string }).value, '0x0');
  assert.equal(f.counts().signCount, 0); assert.equal(f.responses.length, 0);
  const pin = new TextEncoder().encode('123456'); await f.wallet.sign(pin);
  assert.ok(pin.every((byte) => byte === 0));
  const signed = Transaction.fromHex(f.responses[0]!.response.result as string);
  assert.equal(signed.raw.value, 0n); assert.ok(signed.verifySignature());
  f.wallet.invalidate();
});

test('WalletConnect Solana waits for missing ALT context and reads it only after an explicit RPC action', async () => {
  const device = relayDevice('solana'), rpc = walletRpcFixture('solana');
  const f = fixture(['solana_signTransaction'], device.account, [device.account.chainId], device.access, true);
  await f.connect();
  const transaction = solanaFixture(true, true);
  f.request(2, { method: 'solana_signTransaction', params: { transaction: base64.encode(transaction.bytes), pubkey: device.account.address } }); await flush();
  assert.equal(f.responses.length, 0); assert.equal(f.reviews.length, 0); assert.equal(f.contextRequests.length, 1);
  assert.equal(f.contextRequests[0]!.account.chainId, device.account.chainId);
  assert.equal(rpc.calls.length, 0);
  const earlyPin = new TextEncoder().encode('123456'); await assert.rejects(f.wallet.sign(earlyPin));
  assert.ok(earlyPin.every((byte) => byte === 0)); assert.equal(device.counts().tasks, 0);
  await f.wallet.readRpc(rpc.endpoint, rpc.fetcher);
  assert.ok(f.reviews.at(-1)!.review.rows.some(([label, value]) => label === 'ALT 来源与顺序' && value.includes('RPC 返回账户数据')));
  assert.equal(device.counts().signatures, 0);
  await f.wallet.sign(new TextEncoder().encode('123456'));
  const result = f.responses[0]!.response.result as { transaction: string };
  transaction.transaction.sign([solanaSigner]);
  assert.equal(result.transaction, base64.encode(transaction.transaction.serialize()));
  f.wallet.invalidate();
});

test('WalletConnect RPC batch prechecks all versions and still requires each separate signature confirmation', async () => {
  const device = relayDevice('solana'), rpc = walletRpcFixture('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access, true);
  await f.connect();
  const transactions = [solanaFixture(), solanaFixture(true, true), solanaV1Fixture(true)];
  f.request(2, { method: 'solana_signAllTransactions', params: { transactions: transactions.map((item) => base64.encode(item.bytes)) } }); await flush();
  assert.equal(f.contextRequests.length, 1);
  await f.wallet.readRpc(rpc.endpoint, rpc.fetcher);
  assert.equal(rpc.calls.filter((call) => call.method === 'simulateTransaction').length, 3);
  assert.equal(f.rpcStates.at(-1)!.checks.length, 3); assert.equal(f.rpcStates.at(-1)!.signable, true);
  for (let index = 0; index < 3; index++) {
    assert.equal(device.counts().signatures, index);
    assert.equal(f.responses.length, 0);
    await f.wallet.sign(new TextEncoder().encode('123456'));
    if (index === 0) {
      const before = rpc.calls.length;
      await assert.rejects(f.wallet.readRpc(rpc.endpoint, rpc.fetcher)); assert.equal(rpc.calls.length, before);
    }
  }
  const result = f.responses[0]!.response.result as { transactions: string[] };
  result.transactions.forEach((encoded, index) => {
    const decoded = getTransactionDecoder().decode(base64.decode(encoded));
    assert.deepEqual([...decoded.messageBytes], [...transactions[index]!.message]);
    assert.ok(ed25519.verify(new Uint8Array(Object.values(decoded.signatures)[0]!), transactions[index]!.message, solanaSigner.publicKey.toBytes(), { zip215: false }));
  });
  f.wallet.invalidate();
});

test('WalletConnect RPC batch failure in a later transaction blocks every hardware signature and exposes all results', async () => {
  const device = relayDevice('solana'), rpc = walletRpcFixture('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  await f.connect();
  f.request(2, { method: 'solana_signAllTransactions', params: { transactions: [base64.encode(solanaFixture().bytes), base64.encode(solanaV1Fixture().bytes)] } }); await flush();
  const fetcher: typeof fetch = async (url, options) => {
    const call = JSON.parse(options!.body as string) as { method: string };
    if (call.method === 'simulateTransaction' && rpc.calls.some((item) => item.method === 'simulateTransaction')) {
      rpc.results.simulateTransaction = { context: { slot: 13 }, value: { err: 'BlockhashNotFound', logs: [] } };
    }
    return rpc.fetcher(url, options);
  };
  await f.wallet.readRpc(rpc.endpoint, fetcher);
  assert.equal(f.rpcStates.at(-1)!.checks[0]!.signable, true);
  assert.equal(f.rpcStates.at(-1)!.checks[1]!.signable, false);
  assert.equal(f.rpcStates.at(-1)!.signable, false);
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(device.counts().signatures, 0); assert.equal(f.counts().resetCount, 0);
  await f.wallet.reject(); assert.ok(f.responses[0]!.response.error);
  f.wallet.invalidate();
});

test('WalletConnect changing the selected RPC source invalidates the previous review until reread', async () => {
  const f = fixture(['eth_signTransaction'], account, [account.chainId], undefined, true), rpc = walletRpcFixture('evm');
  await f.connect(); f.request(); await flush(); await f.wallet.readRpc(rpc.endpoint, rpc.fetcher);
  f.wallet.changeRpcSource();
  assert.equal(f.rpcStates.at(-1)!.signable, false);
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(f.counts().signCount, 0);
  await f.wallet.readRpc({ ...rpc.endpoint, name: 'Second selected source' }, rpc.fetcher);
  assert.equal(f.rpcStates.at(-1)!.signable, true);
  assert.ok(f.reviews.at(-1)!.review.rows.some(([, value]) => value.includes('Second selected source')));
  await f.wallet.sign(new TextEncoder().encode('123456')); assert.equal(f.counts().signCount, 1);
  f.wallet.invalidate();
});

for (const action of ['reject', 'invalidate', 'expire'] as const) {
  test(`WalletConnect ${action} during RPC cancels the captured request and ignores a late response`, async () => {
    const f = fixture(), rpc = walletRpcFixture('evm'); await f.connect(); f.request(); await flush();
    let release!: () => void, received!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), receiving = new Promise<void>((resolve) => { received = resolve; });
    const pending = f.wallet.readRpc(rpc.endpoint, async (url, options) => { received(); await gate; return rpc.fetcher(url, options); });
    await receiving;
    const pin = new TextEncoder().encode('123456'); await assert.rejects(f.wallet.sign(pin)); assert.ok(pin.every((byte) => byte === 0));
    await assert.rejects(f.wallet.readRpc(rpc.endpoint, rpc.fetcher));
    f.request(3); await flush(); assert.equal(f.responses.length, 1); assert.equal(f.responses[0]!.response.id, 3);
    if (action === 'reject') await f.wallet.reject();
    if (action === 'invalidate') f.wallet.invalidate();
    if (action === 'expire') f.client.emit('session_request_expire', { id: 2 });
    release(); await assert.rejects(pending); await flush();
    assert.equal(f.responses.filter((entry) => entry.response.id === 2).length, 1);
    assert.equal(f.responses.filter((entry) => entry.response.result).length, 0);
    assert.equal(f.counts().signCount, 0); assert.equal(f.counts().resetCount, 0);
    f.wallet.invalidate();
  });
}

test('WalletConnect failed RPC reads reject the request without reviving an older offline approval', async () => {
  for (const failure of ['chain', 'network', 'body']) {
    const f = fixture(), rpc = walletRpcFixture('evm'); await f.connect(); f.request(); await flush();
    if (failure === 'chain') rpc.results.eth_chainId = '0x1';
    const fetcher = failure === 'network' ? async () => { throw new TypeError('failed'); } :
      failure === 'body' ? async () => new Response('invalid') : rpc.fetcher;
    await assert.rejects(f.wallet.readRpc(rpc.endpoint, fetcher));
    await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
    assert.ok(f.responses[0]!.response.error); assert.equal(f.counts().signCount, 0); assert.equal(f.counts().resetCount, 0);
    f.wallet.invalidate();
  }
});

test('WalletConnect RPC context expiry uses the request deadline and prevents later confirmations', async (context) => {
  const f = fixture(), rpc = walletRpcFixture('evm'); await f.connect();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  f.request(2, { expiry: currentTime() + 30 }); await flush();
  await f.wallet.readRpc(rpc.endpoint, rpc.fetcher);
  context.mock.timers.tick(30001); await flush();
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.ok(f.responses[0]!.response.error); assert.equal(f.counts().signCount, 0);
  f.wallet.invalidate();
});

test('WalletConnect RPC context expires during a later batch confirmation and discards saved results', async (context) => {
  const device = relayDevice('solana'), rpc = walletRpcFixture('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access);
  await f.connect(); context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  f.request(2, { method: 'solana_signAllTransactions', params: { transactions: Array(2).fill(base64.encode(solanaFixture().bytes)) } }); await flush();
  await f.wallet.readRpc(rpc.endpoint, rpc.fetcher);
  await f.wallet.sign(new TextEncoder().encode('123456')); assert.equal(f.responses.length, 0);
  context.mock.timers.tick(120001); await flush();
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.ok(f.responses[0]!.response.error); assert.equal(device.counts().signatures, 1);
  f.wallet.invalidate();
});

test('WalletConnect message requests keep their independent signing review and cannot trigger a transaction RPC read', async () => {
  const f = fixture(['personal_sign']), rpc = walletRpcFixture('evm'); await f.connect();
  f.request(2, { method: 'personal_sign', params: ['0x6869', address] }); await flush();
  await assert.rejects(f.wallet.readRpc(rpc.endpoint, rpc.fetcher)); assert.equal(rpc.calls.length, 0);
  await f.wallet.sign(new TextEncoder().encode('123456')); assert.ok(f.responses[0]!.response.result);
  f.wallet.invalidate();
});

test('WalletConnect missing ALT batch validates every envelope before a context prompt or RPC disclosure', async () => {
  const device = relayDevice('solana'), rpc = walletRpcFixture('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access, true);
  await f.connect();
  f.request(2, { method: 'solana_signAllTransactions', params: { transactions: [base64.encode(solanaFixture(true).bytes), 'not base64'] } }); await flush();
  assert.equal(f.contextRequests.length, 0); assert.ok(f.responses[0]!.response.error);
  await assert.rejects(f.wallet.readRpc(rpc.endpoint, rpc.fetcher)); assert.equal(rpc.calls.length, 0);
  assert.equal(device.counts().tasks, 0); f.wallet.invalidate();
});

test('WalletConnect successful batch RPC cannot approve a later unknown instruction after resolving ALT', async () => {
  const device = relayDevice('solana'), rpc = walletRpcFixture('solana');
  const f = fixture(['solana_signAllTransactions'], device.account, [device.account.chainId], device.access, true);
  await f.connect();
  const instruction = new TransactionInstruction({ programId: new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'), keys: [], data: Buffer.of(1) });
  const unreviewable = solanaFixture(false, false, [instruction]);
  f.request(2, { method: 'solana_signAllTransactions', params: { transactions: [base64.encode(solanaFixture(true).bytes), base64.encode(unreviewable.bytes)] } }); await flush();
  await f.wallet.readRpc(rpc.endpoint, rpc.fetcher);
  assert.equal(f.rpcStates.at(-1)!.checks[1]!.signable, false);
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(device.counts().tasks, 0); await f.wallet.reject(); f.wallet.invalidate();
});

test('WalletConnect RPC cannot acquire a new review while the hardware is signing', async () => {
  const f = fixture(), rpc = walletRpcFixture('evm'); await f.connect(); f.request(); await flush();
  const sign = f.access.sign.bind(f.access);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.access.sign = async (operation) => { await gate; return sign(operation); };
  const signing = f.wallet.sign(new TextEncoder().encode('123456'));
  await assert.rejects(f.wallet.readRpc(rpc.endpoint, rpc.fetcher));
  assert.equal(rpc.calls.length, 0); release(); await signing;
  assert.ok(f.responses[0]!.response.result); f.wallet.invalidate();
});

test('unrelated pairing proposals are rejected and approval acknowledgement after account change is disconnected', async () => {
  const f = fixture(); await f.wallet.pair(uri); f.proposal('different'); await flush();
  assert.equal(f.counts().proposalCount, 0); assert.equal(f.rejected.length, 1);
  await f.wallet.pair(uri); f.proposal(); await flush();
  let acknowledge: (() => void) | undefined;
  f.client.approve = async () => ({ acknowledged: () => new Promise((resolve) => { acknowledge = () => resolve(f.session); }) });
  const approval = f.wallet.approve(); await flush(); f.wallet.invalidate(); acknowledge!(); await approval;
  assert.equal(f.disconnected.length, 1);
  f.request(); await flush(); assert.equal(f.counts().reviewCount, 0);
});

test('in-flight signing result is discarded when connection is invalidated', async () => {
  const f = fixture(); await f.connect(); f.request(); await flush();
  let complete: (() => Promise<void>) | undefined;
  f.access.sign = (operation) => new Promise((resolve, reject) => {
    complete = async () => { try { resolve(await operation(transport, new AbortController().signal)); } catch (error) { reject(error); } };
  });
  const signing = f.wallet.sign(new TextEncoder().encode('123456'));
  f.wallet.invalidate(); await complete!(); await assert.rejects(signing);
  assert.ok(f.counts().cancellations > 0); assert.equal(f.responses.filter((entry) => entry.response.result).length, 0);
});

test('pending request timer expires the review and prevents PIN submission', async (context) => {
  const f = fixture(); await f.connect();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  f.request(); await flush(); context.mock.timers.tick(300001); await flush();
  assert.ok(f.responses[0]!.response.error); await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  assert.equal(f.counts().signCount, 0); f.wallet.invalidate();
});

for (const method of ['personal_sign', 'eth_signTypedData_v4'] as const) {
  test(`WalletConnect ${method} reviews before signing and returns a verified 65-byte message signature`, async () => {
    const f = fixture([method]); await f.connect();
    const text = 'Synthetic CanoKeySigner login test';
    const typed = { ...etherMail, domain: { ...etherMail.domain, chainId: '31337' } };
    const params = method === 'personal_sign' ? ['0x' + bytesToHex(new TextEncoder().encode(text)), address] : [address, JSON.stringify(typed)];
    f.request(2, { method, params }); await flush();
    assert.equal(f.counts().reviewCount, 1); assert.equal(f.counts().signCount, 0);
    const pin = new TextEncoder().encode('123456');
    await f.wallet.sign(pin);
    const response = f.responses[0]!.response;
    assert.equal(response.id, 2); assert.ok(!response.error);
    assert.match(response.result as string, /^0x[0-9a-f]{128}1[bc]$/);
    assert.ok(method === 'personal_sign' ? eip191Signer.verify(response.result as string, text, address)
      : verifyTyped(response.result as string, JSON.parse(JSON.stringify(typed)), address));
    assert.ok(pin.every((byte) => byte === 0));
    assert.equal(f.counts().signCount, 1);
    f.wallet.invalidate();
  });
}

test('WalletConnect message methods reject wrong addresses, unknown blind-sign methods and chain-mismatched typed data', async () => {
  const f = fixture(['personal_sign', 'eth_signTypedData_v4']); await f.connect();
  f.request(2, { method: 'personal_sign', params: ['0x6869', '0x0000000000000000000000000000000000000001'] });
  f.request(3, { method: 'eth_sign', params: [address, '0x' + '11'.repeat(32)] });
  f.request(4, { method: 'eth_signTypedData_v4', params: [address, etherMail] });
  await flush();
  assert.equal(f.responses.length, 3);
  assert.ok(f.responses.every((entry) => entry.response.error));
  assert.equal(f.counts().reviewCount, 0); assert.equal(f.counts().signCount, 0);
  f.wallet.invalidate();
});

test('built-in Project ID and auto EVM chains sign only transactions matching each approved request chain', async () => {
  const f = fixture(['eth_signTransaction'], { ...account, network: '', chainId: '' }, ['eip155:1', 'eip155:8453']);
  await f.connect();
  assert.equal((f.initializations[0] as { projectId: string }).projectId, 'd2a8b6044c46a77b4de519960103175c');
  assert.equal(WALLETCONNECT_PROJECT_ID, 'd2a8b6044c46a77b4de519960103175c');
  const transaction = (chainId: string) => [{ type: '0x2', chainId, nonce: '0x0', gas: '0x5208', from: address,
    to: '0x0000000000000000000000000000000000000001', value: '0x0', data: '0x', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', accessList: [] }];
  for (const chainId of ['1', '8453']) {
    f.request(Number(chainId), { chainId: `eip155:${chainId}`, params: transaction(chainId) }); await flush();
    await f.wallet.sign(new TextEncoder().encode('123456'));
    const result = f.responses.at(-1)!.response.result as string;
    assert.equal(Transaction.fromHex(result).raw.chainId, BigInt(chainId));
    assert.ok(Transaction.fromHex(result).verifySignature());
  }
  const before = f.counts().signCount;
  f.request(9000, { chainId: 'eip155:8453', params: transaction('1') });
  f.request(9001, { chainId: 'eip155:137', params: transaction('137') }); await flush();
  assert.ok(f.responses.slice(-2).every((entry) => entry.response.error));
  assert.equal(f.counts().signCount, before);
  f.wallet.invalidate();
});

test('Bitcoin pairing is rejected before SDK initialization or relay traffic', async () => {
  const current: WalletAccount = { ...account, coin: 'bitcoin', network: 'testnet', chainId: accountChain('bitcoin', 'testnet'),
    address: accountAddresses('bitcoin', slot, 'testnet')[0]!.address };
  const f = fixture(['signPsbt'], current);
  await assert.rejects(f.wallet.pair(uri), /手动签名/);
  assert.equal(f.initializations.length, 0); assert.equal(f.pairs.length, 0);
  assert.equal(f.approved.length, 0); assert.equal(f.counts().signCount, 0);
});

test('Bitcoin requests cannot use an existing EVM WalletConnect session', async () => {
  const f = fixture(); await f.connect();
  f.request(2, { method: 'signPsbt', params: {} });
  f.request(3, { method: 'getAccountAddresses', params: {} });
  f.request(4, { method: 'signPsbt', chainId: accountChain('bitcoin', 'testnet'), params: {} }); await flush();
  assert.equal(f.responses.length, 3); assert.ok(f.responses.every((entry) => entry.response.error));
  assert.equal(f.counts().reviewCount, 0); assert.equal(f.counts().signCount, 0);
  f.wallet.invalidate();
});

let sendNonce = 500;
async function sendFixture(sign = true) {
  const f = fixture(['eth_sendTransaction'], account, [account.chainId], undefined, true), rpc = walletRpcFixture('evm');
  rpc.results.eth_getTransactionCount = `0x${(sendNonce++).toString(16)}`;
  rpc.results.eth_maxPriorityFeePerGas = '0x1'; rpc.results.eth_gasPrice = '0x2';
  rpc.results.eth_getTransactionReceipt = null; rpc.results.eth_getTransactionByHash = null;
  await f.connect();
  const params = [{ from: address, to: '0x0000000000000000000000000000000000000001' }];
  f.request(2, { method: 'eth_sendTransaction', params }); await flush();
  if (sign) {
    await f.wallet.readRpc(rpc.endpoint, rpc.fetcher);
    await f.wallet.sign(new TextEncoder().encode('123456'));
    rpc.results.eth_sendRawTransaction = f.submissions.at(-1)!.task.id;
  }
  return { ...f, rpc, params };
}

test('WalletConnect EVM send requires explicit RPC, signature and separate submission, then returns only the local hash', async () => {
  const f = await sendFixture(false);
  assert.equal(f.rpc.calls.length, 0); assert.equal(f.reviews.length, 0); assert.equal(f.contextRequests.length, 1);
  const pin = new TextEncoder().encode('123456'); await assert.rejects(f.wallet.sign(pin)); assert.ok(pin.every((byte) => byte === 0));
  await assert.rejects(f.wallet.submit(f.rpc.fetcher)); assert.equal(f.counts().signCount, 0);
  f.params[0]!.to = '0x0000000000000000000000000000000000000002';
  await f.wallet.readRpc(f.rpc.endpoint, f.rpc.fetcher);
  assert.ok(f.reviews.at(-1)!.review.rows.some(([label, value]) => label === '收款 / 合约地址' && value.endsWith('01')));
  await f.wallet.sign(new TextEncoder().encode('123456'));
  const record = f.submissions.at(-1)!;
  assert.ok(record.active); assert.ok(!record.attempted); assert.ok(Object.isFrozen(record));
  assert.equal(record.requestId, 2); assert.equal(record.dapp, 'Test dApp');
  assert.equal(f.responses.length, 0); assert.equal(f.counts().signCount, 1);
  assert.ok(!f.rpc.calls.some((call) => call.method === 'eth_sendRawTransaction'));
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  await assert.rejects(f.wallet.readRpc(f.rpc.endpoint, f.rpc.fetcher));
  assert.throws(() => f.wallet.closeSubmission());
  f.rpc.results.eth_sendRawTransaction = record.task.id;
  await f.wallet.submit(f.rpc.fetcher);
  assert.equal(f.responses.length, 1); assert.equal(f.responses[0]!.response.result, record.task.id);
  const signed = f.rpc.calls.find((call) => call.method === 'eth_sendRawTransaction')!.params[0] as string;
  const tx = Transaction.fromHex(signed); assert.ok(tx.verifySignature()); assert.equal(tx.sender, address);
  assert.equal(f.submissions.at(-1)!.result!.state, 'accepted'); assert.equal(f.submissions.at(-1)!.active, false);
  await assert.rejects(f.wallet.submit(f.rpc.fetcher)); assert.equal(f.counts().signCount, 1);
  f.wallet.closeSubmission(); assert.equal(f.submissions.at(-1), undefined); f.wallet.invalidate();
});

test('WalletConnect send retains an immutable selected source and requires a new review after source changes', async () => {
  const f = await sendFixture(false);
  await f.wallet.readRpc(f.rpc.endpoint, f.rpc.fetcher);
  f.wallet.changeRpcSource(); await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  await f.wallet.readRpc(f.rpc.endpoint, f.rpc.fetcher);
  const origin = f.rpc.endpoint.url; f.rpc.endpoint.url = 'https://later-change.example/';
  await f.wallet.sign(new TextEncoder().encode('123456'));
  assert.ok(f.submissions.at(-1)!.task.source.includes(new URL(origin).origin));
  assert.ok(!f.submissions.at(-1)!.task.source.includes('later-change'));
  await f.wallet.reject(); f.wallet.closeSubmission(); f.wallet.invalidate();
});

test('WalletConnect send never emits a hash when submission cannot be verified and query recovery never responds a second time', async () => {
  const f = await sendFixture(); let writes = 0;
  const fetcher: typeof fetch = async (url, options) => {
    if ((JSON.parse(options!.body as string) as { method: string }).method === 'eth_sendRawTransaction') { writes++; throw new TypeError('lost response'); }
    return f.rpc.fetcher(url, options);
  };
  const id = f.submissions.at(-1)!.task.id;
  await f.wallet.submit(fetcher);
  assert.equal(writes, 1); assert.equal(f.responses.length, 1); assert.equal(f.responses[0]!.response.result, undefined);
  assert.deepEqual(JSON.parse(f.responses[0]!.response.error!.data!), { transactionHash: id, state: 'unknown' });
  assert.equal(f.submissions.at(-1)!.result!.state, 'unknown');
  f.wallet.invalidate(); await flush();
  f.rpc.results.eth_getTransactionByHash = { hash: id };
  await f.wallet.querySubmission(f.rpc.fetcher);
  assert.equal(f.submissions.at(-1)!.result!.state, 'pending'); assert.equal(f.responses.length, 1);
  assert.equal(f.counts().signCount, 1); f.wallet.closeSubmission();
});

test('WalletConnect send reconciles a lost write response before returning the hash without signing again', async () => {
  const f = await sendFixture(), id = f.submissions.at(-1)!.task.id;
  let writes = 0;
  await f.wallet.submit(async (url, options) => {
    if ((JSON.parse(options!.body as string) as { method: string }).method === 'eth_sendRawTransaction') {
      writes++; f.rpc.results.eth_getTransactionByHash = { hash: id }; throw new TypeError('lost response');
    }
    return f.rpc.fetcher(url, options);
  });
  assert.equal(f.responses[0]!.response.result, id); assert.equal(writes, 1); assert.equal(f.counts().signCount, 1);
  f.wallet.closeSubmission(); f.wallet.invalidate();
});

test('Rejecting or expiring a signed WalletConnect send preserves its ID for queries and disables submission', async () => {
  for (const action of ['reject', 'expire', 'disconnect']) {
    const f = await sendFixture(), record = f.submissions.at(-1)!;
    if (action === 'reject') await f.wallet.reject();
    else if (action === 'expire') f.client.emit('session_request_expire', { id: 2 });
    else f.wallet.invalidate();
    await flush();
    assert.equal(f.responses.length, 1); assert.ok(f.responses[0]!.response.error);
    assert.equal(f.submissions.at(-1)!.task.id, record.task.id); assert.equal(f.submissions.at(-1)!.active, false);
    await assert.rejects(f.wallet.submit(f.rpc.fetcher));
    assert.ok(!f.rpc.calls.some((call) => call.method === 'eth_sendRawTransaction'));
    await f.wallet.querySubmission(f.rpc.fetcher); assert.equal(f.submissions.at(-1)!.result!.state, 'unknown');
    f.wallet.closeSubmission(); f.wallet.invalidate();
  }
});

test('A session change during WalletConnect submission cancels the write outcome and late success cannot become a dApp result', async () => {
  const f = await sendFixture(), id = f.submissions.at(-1)!.task.id;
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  const submitting = f.wallet.submit(async (url, options) => {
    if ((JSON.parse(options!.body as string) as { method: string }).method === 'eth_sendRawTransaction') { reach(); await gate; }
    return f.rpc.fetcher(url, options);
  });
  await reached; await assert.rejects(f.wallet.submit(f.rpc.fetcher));
  f.wallet.invalidate(); await flush(); release(); await submitting;
  assert.equal(f.responses.length, 1); assert.ok(f.responses[0]!.response.error);
  assert.equal(f.submissions.at(-1)!.result!.state, 'unknown'); assert.equal(f.submissions.at(-1)!.task.id, id);
  f.rpc.results.eth_getTransactionByHash = { hash: id }; await f.wallet.querySubmission(f.rpc.fetcher);
  assert.equal(f.submissions.at(-1)!.result!.state, 'pending'); assert.equal(f.responses.length, 1);
  f.wallet.closeSubmission();
});

test('WalletConnect send rechecks account state before writing and reports not-sent on a changed nonce', async () => {
  const f = await sendFixture(); f.rpc.results.eth_getTransactionCount = '0xffff';
  await f.wallet.submit(f.rpc.fetcher);
  assert.equal(f.submissions.at(-1)!.result!.state, 'not-sent'); assert.ok(f.responses[0]!.response.error);
  assert.ok(!f.rpc.calls.some((call) => call.method === 'eth_sendRawTransaction'));
  assert.equal(f.counts().signCount, 1); f.wallet.closeSubmission(); f.wallet.invalidate();
});

test('WalletConnect send keeps a submission record until explicitly closed and rejects duplicate requests without another signature', async () => {
  const f = await sendFixture(); f.request(2, { method: 'eth_sendTransaction', params: f.params }); await flush();
  await f.wallet.submit(f.rpc.fetcher);
  f.request(3, { method: 'eth_sendTransaction', params: f.params }); await flush();
  assert.equal(f.responses.length, 2); assert.ok(f.responses[1]!.response.error?.message.includes('记录'));
  assert.equal(f.counts().signCount, 1);
  f.wallet.closeSubmission(); f.request(4, { method: 'eth_sendTransaction', params: f.params }); await flush();
  assert.equal(f.contextRequests.length, 2); assert.equal(f.counts().signCount, 1);
  await f.wallet.reject(); f.wallet.invalidate();
});

let solanaSendHash = 80;
function solanaSendTransaction(version: 'legacy' | 'v0' | 'v1', multi = true) {
  const hash = base58.encode(new Uint8Array(32).fill(solanaSendHash++));
  if (version === 'v1') {
    const original = solanaV1Fixture(multi);
    return encodeV1Fixture({ ...original.compiled, lifetimeToken: hash as typeof original.compiled.lifetimeToken }, multi);
  }
  const original = solanaFixture(version === 'v0', multi);
  original.transaction.message.recentBlockhash = hash;
  if (multi) original.transaction.sign([solanaOther]);
  return { bytes: original.transaction.serialize(), message: new Uint8Array(original.transaction.message.serialize()) };
}
async function solanaSendFixture(version: 'legacy' | 'v0' | 'v1' = 'legacy', sign = true, sendOptions?: Record<string, unknown>) {
  const device = relayDevice('solana'), rpc = walletRpcFixture('solana');
  const f = fixture(['solana_signAndSendTransaction'], device.account, [device.account.chainId], device.access, true);
  const tx = solanaSendTransaction(version);
  const params = { transaction: base64.encode(tx.bytes), pubkey: device.account.address, ...(sendOptions ? { sendOptions } : {}) };
  rpc.results.getSignatureStatuses = { context: { slot: 20 }, value: [null] };
  await f.connect(); f.request(2, { method: 'solana_signAndSendTransaction', params }); await flush();
  if (sign) {
    await f.wallet.readRpc(rpc.endpoint, rpc.fetcher);
    await f.wallet.sign(new TextEncoder().encode('123456'));
    rpc.results.sendTransaction = f.submissions.at(-1)!.task.id;
  }
  return { ...f, device, rpc, tx, params };
}

for (const version of ['legacy', 'v0', 'v1'] as const) test(`WalletConnect Solana ${version} send needs RPC, a signature and separate submit, preserving original message and cosignatures`, async () => {
  const f = await solanaSendFixture(version, false);
  assert.equal(f.rpc.calls.length, 0); assert.equal(f.contextRequests.length, 1); assert.equal(f.reviews.length, 0);
  await assert.rejects(f.wallet.sign(new TextEncoder().encode('123456')));
  await assert.rejects(f.wallet.submit(f.rpc.fetcher)); assert.equal(f.device.counts().signatures, 0);
  await f.wallet.readRpc(f.rpc.endpoint, f.rpc.fetcher);
  const review = f.reviews.at(-1)!.review; assert.ok(review.chain === 'solana' && !('kind' in review));
  assert.equal(review.messageHex, bytesToHex(f.tx.message));
  const pin = new TextEncoder().encode('123456'); await f.wallet.sign(pin); assert.ok(pin.every((byte) => byte === 0));
  const record = f.submissions.at(-1)!; assert.equal(record.task.chain, 'solana'); assert.equal(f.responses.length, 0);
  assert.equal(f.device.counts().signatures, 1); assert.ok(!f.rpc.calls.some((call) => call.method === 'sendTransaction'));
  f.rpc.results.sendTransaction = record.task.id;
  await f.wallet.submit(f.rpc.fetcher);
  assert.deepEqual(f.responses[0]!.response.result, { signature: record.task.id });
  const write = f.rpc.calls.find((call) => call.method === 'sendTransaction')!;
  const signed = decodeSolanaEnvelope(write.params[0] as string), original = decodeSolanaEnvelope(f.params.transaction);
  assert.deepEqual(signed.messageBytes, f.tx.message); assert.deepEqual(signed.signatures[1], original.signatures[1]);
  assert.ok(ed25519.verify(signed.signatures[0]!, f.tx.message, solanaSigner.publicKey.toBytes(), { zip215: false }));
  assert.equal(base58.encode(signed.signatures[0]!), record.task.id);
  assert.deepEqual(write.params[1], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
  await assert.rejects(f.wallet.submit(f.rpc.fetcher)); assert.equal(f.device.counts().signatures, 1);
  f.wallet.closeSubmission(); f.wallet.invalidate();
});

test('WalletConnect Solana sends the first fee-payer signature as ID when CanoKey signs a different slot', async () => {
  const device = relayDevice('solana'), rpc = walletRpcFixture('solana');
  const f = fixture(['solana_signAndSendTransaction'], device.account, [device.account.chainId], device.access, true);
  const message = new TransactionMessage({ payerKey: solanaOther.publicKey,
    recentBlockhash: base58.encode(new Uint8Array(32).fill(solanaSendHash++)),
    instructions: [SystemProgram.transfer({ fromPubkey: solanaSigner.publicKey, toPubkey: solanaDestination, lamports: 17n })] }).compileToLegacyMessage();
  const transaction = new VersionedTransaction(message); transaction.sign([solanaOther]);
  const first = base58.encode(transaction.signatures[0]!);
  rpc.results.getSignatureStatuses = { context: { slot: 20 }, value: [null] }; rpc.results.sendTransaction = first;
  await f.connect(); f.request(2, { method: 'solana_signAndSendTransaction', params: { transaction: base64.encode(transaction.serialize()) } }); await flush();
  await f.wallet.readRpc(rpc.endpoint, rpc.fetcher); await f.wallet.sign(new TextEncoder().encode('123456'));
  assert.equal(f.submissions.at(-1)!.task.id, first);
  await f.wallet.submit(rpc.fetcher); assert.deepEqual(f.responses[0]!.response.result, { signature: first });
  const signed = decodeSolanaEnvelope(rpc.calls.find((call) => call.method === 'sendTransaction')!.params[0] as string);
  assert.notEqual(base58.encode(signed.signatures[1]!), first); assert.deepEqual(signed.signatures[0], transaction.signatures[0]);
  f.wallet.closeSubmission(); f.wallet.invalidate();
});

test('WalletConnect Solana binds requested sendOptions before RPC and preserves them through fresh checks and one write', async () => {
  const options = { skipPreflight: true, preflightCommitment: 'finalized', maxRetries: 3, minContextSlot: 10 };
  const f = await solanaSendFixture('v0', false, options), source = f.params.transaction;
  options.maxRetries = 99; options.minContextSlot = 999;
  f.params.transaction = base64.encode(solanaSendTransaction('v0').bytes);
  await f.wallet.readRpc(f.rpc.endpoint, f.rpc.fetcher); await f.wallet.sign(new TextEncoder().encode('123456'));
  f.rpc.results.sendTransaction = f.submissions.at(-1)!.task.id;
  await f.wallet.submit(f.rpc.fetcher);
  const write = f.rpc.calls.find((call) => call.method === 'sendTransaction')!;
  assert.deepEqual(write.params[1], { encoding: 'base64', skipPreflight: true, preflightCommitment: 'finalized', maxRetries: 3, minContextSlot: 10 });
  const original = decodeSolanaEnvelope(source), signed = decodeSolanaEnvelope(write.params[0] as string);
  assert.deepEqual(signed.messageBytes, original.messageBytes);
  for (const call of f.rpc.calls.filter((call) => call.method === 'simulateTransaction')) {
    assert.equal((call.params[1] as { commitment: string }).commitment, 'finalized');
    assert.equal((call.params[1] as { replaceRecentBlockhash: boolean }).replaceRecentBlockhash, false);
  }
  f.wallet.closeSubmission(); f.wallet.invalidate();
});

test('Solana send with missing cosignatures is rejected before RPC or device access', async () => {
  const device = relayDevice('solana'), f = fixture(['solana_signAndSendTransaction'], device.account, [device.account.chainId], device.access, true);
  const tx = solanaFixture(false, true); tx.transaction.signatures[1] = new Uint8Array(64);
  await f.connect(); f.request(2, { method: 'solana_signAndSendTransaction', params: { transaction: base64.encode(tx.transaction.serialize()) } }); await flush();
  assert.ok(f.responses[0]!.response.error?.message.includes('协签'));
  assert.equal(f.contextRequests.length, 0); assert.equal(device.counts().signatures, 0);
  f.wallet.invalidate();
});

test('Solana send reports uncertain writes using signature metadata and query recovery cannot reply twice', async () => {
  const f = await solanaSendFixture('v1'), id = f.submissions.at(-1)!.task.id;
  f.rpc.results.sendTransaction = 'wrong-signature'; await f.wallet.submit(f.rpc.fetcher);
  assert.equal(f.responses.length, 1); assert.equal(f.responses[0]!.response.result, undefined);
  assert.deepEqual(JSON.parse(f.responses[0]!.response.error!.data!), { signature: id, state: 'unknown' });
  f.wallet.invalidate();
  f.rpc.results.getSignatureStatuses = { context: { slot: 20 }, value: [{ slot: 19, err: null, confirmationStatus: 'finalized' }] };
  await f.wallet.querySubmission(f.rpc.fetcher); assert.equal(f.submissions.at(-1)!.result!.state, 'confirmed');
  assert.equal(f.responses.length, 1); assert.equal(f.device.counts().signatures, 1);
  assert.equal(f.rpc.calls.filter((call) => call.method === 'sendTransaction').length, 1);
  f.wallet.closeSubmission();
});

test('Solana send never returns late acceptance after session expiry during a write and keeps the original ID', async () => {
  const f = await solanaSendFixture(), id = f.submissions.at(-1)!.task.id;
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  const submitting = f.wallet.submit(async (url, options) => {
    if ((JSON.parse(options!.body as string) as { method: string }).method === 'sendTransaction') { reach(); await gate; }
    return f.rpc.fetcher(url, options);
  });
  await reached; f.client.emit('session_request_expire', { id: 2 }); await flush(); release(); await submitting;
  assert.equal(f.responses.length, 1); assert.ok(f.responses[0]!.response.error);
  assert.deepEqual(JSON.parse(f.responses[0]!.response.error!.data!), { signature: id, state: 'unknown' });
  assert.equal(f.submissions.at(-1)!.task.id, id); assert.equal(f.submissions.at(-1)!.result!.state, 'unknown');
  assert.equal(f.device.counts().signatures, 1); f.wallet.closeSubmission(); f.wallet.invalidate();
});

test('Solana send fails before a write when its original blockhash is no longer executable', async () => {
  const f = await solanaSendFixture();
  f.rpc.results.simulateTransaction = { context: { slot: 13 }, value: { err: 'BlockhashNotFound', logs: [] } };
  await f.wallet.submit(f.rpc.fetcher);
  assert.equal(f.submissions.at(-1)!.result!.state, 'not-sent'); assert.ok(f.responses[0]!.response.error);
  assert.equal(f.rpc.calls.filter((call) => call.method === 'sendTransaction').length, 0);
  assert.equal(f.device.counts().signatures, 1); f.wallet.closeSubmission(); f.wallet.invalidate();
});


test('unlisted EVM chains connect without RPC and sign EIP-712 after a rejected send request', async () => {
  const chain = '5042002';
  const f = fixture(['eth_sendTransaction', 'eth_signTypedData_v4'], { ...account, network: '', chainId: '' }, [`eip155:${chain}`], undefined, true, () => false, ['accountsChanged', 'chainChanged']);
  await f.connect();
  assert.equal(f.rejected.length, 0);
  assert.equal(f.counts().proposalCount, 1);
  f.request(2, { chainId: `eip155:${chain}`, method: 'eth_sendTransaction' }); await flush();
  assert.match(f.responses[0]!.response.error!.message, /RPC/);
  assert.equal(f.counts().signCount, 0);
  assert.equal(f.contextRequests.length, 0);
  const typed = { ...etherMail, domain: { ...etherMail.domain, chainId: chain } };
  f.request(3, { chainId: `eip155:${chain}`, method: 'eth_signTypedData_v4', params: [address, typed] }); await flush();
  assert.equal(f.counts().reviewCount, 1);
  await f.wallet.sign(new TextEncoder().encode('123456'));
  const signature = f.responses.find((entry) => entry.response.id === 3)!.response.result as string;
  assert.ok(verifyTyped(signature, JSON.parse(JSON.stringify(typed)), address));
  f.request(4, { chainId: `eip155:${chain}`, method: 'eth_signTypedData_v4', params: [address, etherMail] });
  f.request(5, { chainId: 'eip155:1', method: 'eth_signTypedData_v4', params: [address, etherMail] });
  await flush();
  const rejected = f.responses.filter((entry) => [4, 5].includes(entry.response.id));
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((entry) => entry.response.error));
  assert.equal(f.counts().signCount, 1);
  f.wallet.invalidate();
});


test('proposal failures show the exact unsupported method to the user', async () => {
  const f = fixture(['wallet_unsupportedMethod'], { ...account, network: '', chainId: '' }, ['eip155:5042002']);
  await f.wallet.pair(uri); f.proposal(); await flush();
  assert.equal(f.rejected.length, 1);
  assert.ok(f.statuses.some((status) => status.includes('不支持的方法 wallet_unsupportedMethod')));
  assert.equal(f.counts().proposalCount, 0);
  assert.equal(f.counts().signCount, 0);
  f.wallet.invalidate();
});


test('Safe-style optional chain proposals switch to Arc testnet and sign without an RPC', async () => {
  const methods = ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain'];
  const chains = ['eip155:1', 'eip155:5042002'];
  const f = fixture(methods, { ...account, network: '', chainId: '' }, chains, undefined, true, () => false, ['chainChanged', 'accountsChanged']);
  await f.wallet.pair(uri);
  f.client.emit('session_proposal', { id: 1, params: { id: 1, expiryTimestamp: currentTime() + 300, pairingTopic: topic,
    requiredNamespaces: {}, optionalNamespaces: { eip155: { chains, methods: [...methods, 'eth_sign', 'wallet_addEthereumChain'], events: ['chainChanged', 'accountsChanged', 'message'] } } } });
  await flush(); await f.wallet.approve();
  f.request(2, { chainId: 'eip155:1', method: 'wallet_switchEthereumChain', params: [{ chainId: '0x4cef52' }] }); await flush();
  assert.equal(f.responses[0]!.response.error, undefined);
  assert.equal(f.responses[0]!.response.result, null);
  assert.deepEqual(f.emitted, [{ topic, chainId: 'eip155:5042002', event: { name: 'chainChanged', data: '0x4cef52' } }]);
  f.request(3, { chainId: 'eip155:5042002', method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] }); await flush();
  assert.ok(f.responses[1]!.response.error);
  assert.equal(f.emitted.length, 1);
  f.request(5, { chainId: 'eip155:5042002', method: 'wallet_switchEthereumChain', params: [{ chainId: '0x4cef52' }] }); await flush();
  assert.equal(f.responses.at(-1)!.response.result, null);
  assert.equal(f.emitted.length, 1);
  const typed = {
    types: {
      EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      SafeTx: [
        { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'SafeTx',
    domain: { chainId: '5042002', verifyingContract: '0x' + '12'.repeat(20) },
    message: { to: '0x' + '34'.repeat(20), value: '0', data: '0x', operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0',
      gasToken: '0x' + '00'.repeat(20), refundReceiver: '0x' + '00'.repeat(20), nonce: '1' },
  };
  f.request(4, { chainId: 'eip155:5042002', method: 'eth_signTypedData_v4', params: [address, typed] }); await flush();
  await f.wallet.sign(new TextEncoder().encode('123456'));
  const signature = f.responses.find((entry) => entry.response.id === 4)!.response.result as string;
  assert.ok(verifyTyped(signature, JSON.parse(JSON.stringify(typed)), address));
  assert.equal(f.counts().signCount, 1);
  f.wallet.invalidate();
});
