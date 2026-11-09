import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SignClient } from '@walletconnect/sign-client';
import type SignClientType from '@walletconnect/sign-client';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { eip191Signer, Transaction, verifyTyped } from 'micro-eth-signer';
import { VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createWalletConnection, WALLETCONNECT_PROJECT_ID } from '../src/connectors/walletconnect/client';
import type { WalletSubmission } from '../src/connectors/walletconnect/client';
import { walletMethods } from '../src/connectors/walletconnect/policy';
import type { Review } from '../src/signing/execute';
import { relayDevice } from './fixtures/relay-device';
import { etherMail } from './fixtures/evm-message';
import { tokenCallVectors, encodeTokenCall, tokenTransactionInput } from './fixtures/evm-calldata';
import { offchainMessageFixture } from './fixtures/solana-message';
import { solanaFixture, solanaOther } from './fixtures/solana';
import { token2022Instruction, token2022Vectors } from './fixtures/token2022';
import { solanaV1Fixture, encodeV1Fixture } from './fixtures/solana-v1';
import { getTransactionDecoder } from '@solana/transactions';
import { walletRpcFixture } from './fixtures/wallet-rpc';

process.env.DISABLE_GLOBAL_CORE = 'true';
Object.defineProperty(globalThis, '__WALLETCONNECT__', { value: true });
Object.defineProperty(globalThis, 'window', { value: { location: { origin: 'http://127.0.0.1:4173' } } });
type Options = NonNullable<Parameters<typeof SignClient.init>[0]>;
function memoryStorage(): NonNullable<Options['storage']> {
  const entries = new Map<string, unknown>();
  return {
    async getKeys() { return [...entries.keys()]; },
    async getEntries<T>() { return [...entries].map(([key, value]) => [key, structuredClone(value) as T]); },
    async getItem<T>(key: string) { return structuredClone(entries.get(key)) as T | undefined; },
    async setItem<T>(key: string, value: T) { entries.set(key, structuredClone(value)); },
    async removeItem(key: string) { entries.delete(key); },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function timed<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded 30 seconds`)), 30000);
    })]);
  } finally { clearTimeout(timer); }
}
const clients: SignClientType[] = [];
const cases: { coin: string; method: string; variant?: string; verified: boolean }[] = [];
let stage = 'initialize';
async function initialize(options: Options, role: string): Promise<SignClientType> {
  const client = await timed(SignClient.init({ ...options, storage: memoryStorage(), customStoragePrefix: `canokey-relay-${role}-${randomUUID()}` }), 'SDK initialization');
  clients.push(client);
  return client;
}

async function run(coin: 'evm' | 'solana'): Promise<void> {
  stage = `${coin} pairing`;
  console.log(stage);
  const device = relayDevice(coin), account = device.account;
  const chainId = coin === 'evm' ? 'eip155:31337' : account.chainId;
  const namespace = coin === 'evm' ? 'eip155' : 'solana';
  const proposal = deferred<void>();
  let request = deferred<{ review: Review; method: string; batch: { index: number; total: number } | undefined }>();
  let contextRequest = deferred<void>();
  let submission = deferred<WalletSubmission>();
  let snapshots = '[]';
  let walletClient: SignClientType | undefined;
  const statuses: string[] = [];
  const wallet = createWalletConnection(device.access, {
    account: () => account, snapshots: () => snapshots, clear: () => undefined,
    status: (text) => { statuses.push(text); },
    proposal: () => { proposal.resolve(); }, request: (review, method, batch) => { request.resolve({ review, method, batch }); },
    contextRequired: () => contextRequest.resolve(),
    submission: (record) => { if (record?.active && !record.attempted) submission.resolve(record); },
  }, async (options) => { walletClient = await initialize(options ?? {}, 'wallet'); return walletClient; });
  const dapp = await initialize({ projectId: WALLETCONNECT_PROJECT_ID, relayUrl: 'wss://relay.walletconnect.org', telemetryEnabled: false, logger: 'silent',
    metadata: { name: 'CanoKeySigner synthetic dApp', description: 'Dedicated protocol interoperability test', url: 'http://127.0.0.1:4173', icons: [] } }, 'dapp');
  try {
    const connection = await timed(dapp.connect({ optionalNamespaces: { [namespace]: { chains: [chainId], methods: [...walletMethods[coin]], events: [] } } }), 'Create pairing');
    assert.ok(connection.uri);
    const settled = timed(connection.approval(), 'Approve session');
    // Attach a rejection handler while the explicit proposal approval is pending.
    void settled.catch(() => undefined);
    await timed(wallet.pair(connection.uri), 'Wallet pair');
    await timed(proposal.promise, `Proposal receipt (${statuses.at(-1) ?? 'waiting'})`);
    assert.equal(device.counts().signatures, 0);
    await timed(wallet.approve(), 'Wallet approval');
    const session = await settled;
    assert.ok(walletClient?.core.relayer.connected && dapp.core.relayer.connected);
    assert.ok(session.namespaces[namespace]!.accounts.includes(`${chainId}:${account.address}`));
    cases.push({ coin, method: 'pair / approve', verified: true });

    async function signedRequest<T>(method: string, params: unknown, verify: (result: T) => void, variant?: string, inspectRpc = false) {
      stage = `${coin} ${method}${variant ? ` (${variant})` : ''}`; console.log(stage);
      request = deferred();
      const before = device.counts().signatures;
      const pending = timed(dapp.request<T>({ topic: session.topic, chainId, request: { method, params } }), method);
      void pending.catch(() => undefined);
      let review = await timed(request.promise, `${method} review`);
      if (inspectRpc) {
        const rpc = walletRpcFixture(coin);
        assert.equal(rpc.calls.length, 0); request = deferred();
        await timed(wallet.readRpc(rpc.endpoint, rpc.fetcher), 'Explicit request RPC read');
        review = await timed(request.promise, 'Review after RPC read');
        assert.ok(rpc.calls.length > 0);
        assert.ok(review.review.rows.some(([label]) => label.startsWith('RPC')));
      }
      assert.equal(review.method, method); assert.ok(review.review.signable);
      assert.equal(device.counts().signatures, before);
      const pin = new TextEncoder().encode('123456');
      await timed(wallet.sign(pin), `${method} signature`);
      assert.ok(pin.every((byte) => byte === 0));
      verify(await pending);
      assert.equal(device.counts().signatures, before + 1);
      cases.push({ coin, method, ...(variant ? { variant } : {}), verified: true });
    }
    if (coin === 'evm') {
      for (const variant of ['accepted', 'lost response / query recovery', 'uncertain response / error with local ID', 'rejected after signature']) {
        stage = `evm eth_sendTransaction (${variant})`; console.log(stage);
        contextRequest = deferred(); request = deferred(); submission = deferred();
        const rpc = walletRpcFixture('evm'), nonce = 700 + cases.length;
        rpc.results.eth_getTransactionCount = `0x${nonce.toString(16)}`;
        rpc.results.eth_maxPriorityFeePerGas = '0x1';
        rpc.results.eth_getTransactionReceipt = null; rpc.results.eth_getTransactionByHash = null;
        const pending = timed(dapp.request<string>({ topic: session.topic, chainId, request: { method: 'eth_sendTransaction',
          params: [{ from: account.address, to: '0x0000000000000000000000000000000000000001' }] } }), stage);
        void pending.catch(() => undefined);
        await timed(contextRequest.promise, 'Send request context');
        const before = device.counts().signatures;
        await timed(wallet.readRpc(rpc.endpoint, rpc.fetcher), 'Send request RPC read');
        const checked = await timed(request.promise, 'Send request review');
        assert.ok(checked.review.signable); assert.equal(checked.method, 'eth_sendTransaction');
        assert.equal(device.counts().signatures, before);
        await timed(wallet.sign(new TextEncoder().encode('123456')), 'Send request hardware signature');
        const record = await timed(submission.promise, 'Signed send request');
        assert.equal(device.counts().signatures, before + 1);
        assert.ok(!rpc.calls.some((call) => call.method === 'eth_sendRawTransaction'));
        rpc.results.eth_sendRawTransaction = record.task.id;
        let writes = 0;
        if (variant === 'rejected after signature') {
          await wallet.reject(); await assert.rejects(pending);
          assert.equal(writes, 0);
        } else {
          await timed(wallet.submit(async (url, options) => {
            const body = JSON.parse(options!.body as string) as { method: string; params: unknown[] };
            if (body.method === 'eth_sendRawTransaction') {
              writes++;
              const transaction = Transaction.fromHex(body.params[0] as string);
              assert.ok(transaction.verifySignature()); assert.equal(transaction.sender, account.address);
              assert.equal(transaction.raw.nonce, BigInt(nonce));
              if (variant === 'lost response / query recovery') { rpc.results.eth_getTransactionByHash = { hash: record.task.id }; throw new TypeError('response lost'); }
              if (variant === 'uncertain response / error with local ID') throw new TypeError('response lost');
            }
            return rpc.fetcher(url, options);
          }), 'Explicit submit');
          if (variant === 'uncertain response / error with local ID') {
            await assert.rejects(pending, (error: unknown) => {
              assert.ok(error && typeof error === 'object' && 'data' in error && typeof error.data === 'string');
              assert.equal((JSON.parse(error.data) as { transactionHash: string }).transactionHash, record.task.id);
              return true;
            });
          } else assert.equal(await pending, record.task.id);
          assert.equal(writes, 1);
        }
        wallet.closeSubmission();
        cases.push({ coin, method: 'eth_sendTransaction', variant, verified: true });
      }
      const text = 'CanoKeySigner relay interoperability test. Synthetic test key and message.';
      await signedRequest<string>('personal_sign', ['0x' + bytesToHex(new TextEncoder().encode(text)), account.address], (signature) => {
        assert.ok(eip191Signer.verify(signature, text, account.address));
      });
      const typed = { ...etherMail, domain: { ...etherMail.domain, chainId: '31337' } };
      await signedRequest<string>('eth_signTypedData_v4', [account.address, JSON.stringify(typed)], (signature) => {
        assert.ok(verifyTyped(signature, JSON.parse(JSON.stringify(typed)), account.address));
      });
      await signedRequest<string>('eth_signTransaction', [{ type: '0x2', chainId: '0x7a69', nonce: '0x0', gas: '0x5208', from: account.address,
        to: '0x0000000000000000000000000000000000000001', value: '0x0', data: '0x', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', accessList: [] }], (result) => {
        const transaction = Transaction.fromHex(result);
        assert.ok(transaction.verifySignature()); assert.equal(transaction.sender, account.address); assert.equal(transaction.raw.chainId, 31337n);
      });
      await signedRequest<string>('eth_signTransaction', [{ type: '0x2', chainId: '0x7a69', nonce: '0x0', gas: '0x5208', from: account.address,
        to: '0x0000000000000000000000000000000000000001', value: '0x0', data: '0x', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', accessList: [] }], (result) => {
        const transaction = Transaction.fromHex(result);
        assert.ok(transaction.verifySignature()); assert.equal(transaction.sender, account.address); assert.equal(transaction.raw.chainId, 31337n);
      }, 'explicit RPC read / second review / original transaction', true);
      for (const selector of ['a22cb465', '2eb2c2d6']) {
        const vector = tokenCallVectors.find((vector) => vector.selector === selector)!;
        const data = encodeTokenCall(vector.signature, vector.args);
        await signedRequest<string>('eth_signTransaction', [{ ...tokenTransactionInput(data), from: account.address }], (result) => {
          const transaction = Transaction.fromHex(result);
          assert.ok(transaction.verifySignature()); assert.equal(transaction.sender, account.address);
          assert.equal(`0x${transaction.raw.data.replace(/^0x/, '')}`, data);
        }, vector.signature);
      }
    } else {
      const sends = [
        { version: 'legacy', outcome: 'accepted' }, { version: 'v0', outcome: 'accepted' }, { version: 'v1', outcome: 'accepted' },
        { version: 'legacy', outcome: 'recovered' }, { version: 'legacy', outcome: 'unknown' }, { version: 'legacy', outcome: 'rejected' },
      ];
      for (const [index, entry] of sends.entries()) {
        stage = `solana solana_signAndSendTransaction (${entry.version} / ${entry.outcome})`; console.log(stage);
        contextRequest = deferred(); request = deferred(); submission = deferred();
        const rpc = walletRpcFixture('solana'), hash = base58.encode(new Uint8Array(32).fill(140 + index));
        let bytes: Uint8Array;
        if (entry.version === 'v1') {
          const original = solanaV1Fixture(true);
          bytes = encodeV1Fixture({ ...original.compiled, lifetimeToken: hash as typeof original.compiled.lifetimeToken }, true).bytes;
        } else {
          const original = solanaFixture(entry.version === 'v0', true);
          original.transaction.message.recentBlockhash = hash; original.transaction.sign([solanaOther]);
          bytes = original.transaction.serialize();
        }
        const original = getTransactionDecoder().decode(bytes);
        const sendOptions = entry.version === 'v0' ? { skipPreflight: true, preflightCommitment: 'finalized', maxRetries: 2, minContextSlot: 10 } : undefined;
        rpc.results.getSignatureStatuses = { context: { slot: 20 }, value: [null] };
        const before = device.counts().signatures;
        const pending = timed(dapp.request<{ signature: string }>({ topic: session.topic, chainId,
          request: { method: 'solana_signAndSendTransaction', params: { transaction: base64.encode(bytes), pubkey: account.address, ...(sendOptions ? { sendOptions } : {}) } } }), stage);
        void pending.catch(() => undefined);
        await timed(contextRequest.promise, 'Solana send RPC prompt');
        assert.equal(device.counts().signatures, before); assert.equal(rpc.calls.length, 0);
        await timed(wallet.readRpc(rpc.endpoint, rpc.fetcher), 'Solana send explicit RPC');
        const checked = await timed(request.promise, 'Solana send full review'); assert.ok(checked.review.signable);
        await timed(wallet.sign(new TextEncoder().encode('123456')), 'Solana send hardware signature');
        const record = await timed(submission.promise, 'Signed Solana send request');
        assert.equal(device.counts().signatures, before + 1);
        assert.ok(!rpc.calls.some((call) => call.method === 'sendTransaction'));
        rpc.results.sendTransaction = record.task.id;
        let writes = 0;
        if (entry.outcome === 'rejected') { await wallet.reject(); await assert.rejects(pending); }
        else {
          await timed(wallet.submit(async (url, options) => {
            const body = JSON.parse(options!.body as string) as { method: string; params: unknown[] };
            if (body.method === 'sendTransaction') {
              writes++;
              const signed = getTransactionDecoder().decode(base64.decode(body.params[0] as string));
              assert.deepEqual([...signed.messageBytes], [...original.messageBytes]);
              assert.deepEqual([...Object.values(signed.signatures)[1]!], [...Object.values(original.signatures)[1]!]);
              const first = new Uint8Array(Object.values(signed.signatures)[0]!);
              assert.ok(ed25519.verify(first, new Uint8Array(original.messageBytes), base58.decode(account.address), { zip215: false }));
              assert.equal(base58.encode(first), record.task.id);
              if (sendOptions) assert.deepEqual(body.params[1], { encoding: 'base64', ...sendOptions });
              if (entry.outcome === 'recovered') {
                rpc.results.getSignatureStatuses = { context: { slot: 20 }, value: [{ slot: 19, err: null, confirmationStatus: 'confirmed' }] };
                throw new TypeError('lost response');
              }
              if (entry.outcome === 'unknown') throw new TypeError('lost response');
            }
            return rpc.fetcher(url, options);
          }), 'Solana single explicit submit');
          if (entry.outcome === 'unknown') await assert.rejects(pending, (error: unknown) => {
            assert.ok(error && typeof error === 'object' && 'data' in error && typeof error.data === 'string');
            assert.deepEqual(JSON.parse(error.data), { signature: record.task.id, state: 'unknown' }); return true;
          });
          else assert.deepEqual(await pending, { signature: record.task.id });
          assert.equal(writes, 1);
        }
        assert.equal(device.counts().signatures, before + 1); wallet.closeSubmission();
        cases.push({ coin, method: 'solana_signAndSendTransaction', variant: `${entry.version} / ${entry.outcome}`, verified: true });
      }
      const accounts = await timed(dapp.request<{ pubkey: string }[]>({ topic: session.topic, chainId, request: { method: 'solana_getAccounts', params: {} } }), 'Read Solana account');
      assert.deepEqual(accounts, [{ pubkey: account.address }]);
      cases.push({ coin, method: 'solana_getAccounts', verified: true });
      for (const version of [0, 1] as const) {
        const message = offchainMessageFixture({ version });
        await signedRequest<{ signature: string }>('solana_signMessage', { message: base58.encode(message), pubkey: account.address }, (result) => {
          assert.deepEqual(Object.keys(result), ['signature']);
          assert.ok(ed25519.verify(base58.decode(result.signature), message, base58.decode(account.address), { zip215: false }));
        }, `offchain v${version}`);
      }
      for (const v0 of [false, true]) {
        const fixture = solanaFixture(v0, true); snapshots = fixture.snapshots;
        await signedRequest<{ transaction: string; signature: string }>('solana_signTransaction', { transaction: base64.encode(fixture.bytes), pubkey: account.address }, (result) => {
          const transaction = VersionedTransaction.deserialize(base64.decode(result.transaction));
          assert.deepEqual(transaction.message.serialize(), fixture.message);
          assert.deepEqual(transaction.signatures[1], fixture.transaction.signatures[1]);
          assert.ok(ed25519.verify(base58.decode(result.signature), fixture.message, transaction.message.staticAccountKeys[0]!.toBytes(), { zip215: false }));
          assert.deepEqual(base58.decode(result.signature), transaction.signatures[0]);
        }, v0 ? 'v0 / ALT / partial multisig' : 'legacy / partial multisig');
      }
      stage = 'solana missing ALT / explicit RPC read'; console.log(stage);
      snapshots = '[]'; request = deferred(); contextRequest = deferred();
      const unresolved = solanaFixture(true, true), altRpc = walletRpcFixture('solana');
      const unsignedCount = device.counts().signatures;
      const resolvedResult = timed(dapp.request<{ transaction: string; signature: string }>({ topic: session.topic, chainId,
        request: { method: 'solana_signTransaction', params: { transaction: base64.encode(unresolved.bytes) } } }), 'ALT request result');
      void resolvedResult.catch(() => undefined);
      await timed(contextRequest.promise, 'Missing ALT context prompt');
      assert.equal(altRpc.calls.length, 0); assert.equal(device.counts().signatures, unsignedCount);
      await timed(wallet.readRpc(altRpc.endpoint, altRpc.fetcher), 'Fetch missing ALT context');
      const resolvedReview = await timed(request.promise, 'Resolved ALT request review');
      assert.ok(resolvedReview.review.rows.some(([label, value]) => label === 'ALT 来源与顺序' && value.includes('RPC 返回账户数据')));
      assert.equal(device.counts().signatures, unsignedCount);
      await timed(wallet.sign(new TextEncoder().encode('123456')), 'Resolved ALT signature');
      const altResult = await resolvedResult;
      const decodedAlt = VersionedTransaction.deserialize(base64.decode(altResult.transaction));
      assert.deepEqual(decodedAlt.message.serialize(), unresolved.message);
      assert.deepEqual(decodedAlt.signatures[1], unresolved.transaction.signatures[1]);
      assert.ok(ed25519.verify(base58.decode(altResult.signature), unresolved.message, base58.decode(account.address), { zip215: false }));
      cases.push({ coin, method: 'solana_signTransaction', variant: 'missing ALT / explicit RPC read / new approval', verified: true });
      for (const name of ['transferWithFeeMultisig', 'enableMemo']) {
        const vector = token2022Vectors.find((item) => item.name === name)!;
        const fixture = solanaFixture(true, vector.multi, [token2022Instruction(vector)]); snapshots = fixture.snapshots;
        await signedRequest<{ transaction: string; signature: string }>('solana_signTransaction', { transaction: base64.encode(fixture.bytes) }, (result) => {
          const transaction = VersionedTransaction.deserialize(base64.decode(result.transaction));
          assert.deepEqual(transaction.message.serialize(), fixture.message);
          if (vector.multi) assert.deepEqual(transaction.signatures[1], fixture.transaction.signatures[1]);
          assert.ok(ed25519.verify(transaction.signatures[0]!, fixture.message, base58.decode(account.address), { zip215: false }));
          assert.deepEqual(base58.decode(result.signature), transaction.signatures[0]);
        }, `Token-2022 / ${name}`);
      }
      const v1 = solanaV1Fixture(true);
      await signedRequest<{ transaction: string; signature: string }>('solana_signTransaction', { transaction: base64.encode(v1.bytes) }, (result) => {
        const transaction = getTransactionDecoder().decode(base64.decode(result.transaction));
        assert.deepEqual(new Uint8Array(transaction.messageBytes), v1.message);
        assert.deepEqual([...Object.values(transaction.signatures)[1]!], [...Object.values(v1.transaction.signatures)[1]!]);
        assert.ok(ed25519.verify(base58.decode(result.signature), v1.message, base58.decode(account.address), { zip215: false }));
        assert.deepEqual([...Object.values(transaction.signatures)[0]!], [...base58.decode(result.signature)]);
      }, 'v1 / inline resources / tail signatures / partial multisig');
      stage = 'solana solana_signAllTransactions'; console.log(stage);
      const fixtures = [solanaFixture(false, true), solanaFixture(true, true), v1] as const;
      snapshots = fixtures[1]!.snapshots;
      const params = { transactions: fixtures.map((fixture) => base64.encode(fixture.bytes)) };
      request = deferred();
      let returned = false;
      const before = device.counts().signatures;
      const batchResult = timed(dapp.request<{ transactions: string[] }>({ topic: session.topic, chainId,
        request: { method: 'solana_signAllTransactions', params } }), 'Batch response');
      void batchResult.then(() => { returned = true; }, () => undefined);
      await timed(request.promise, 'Original batch review');
      request = deferred();
      const batchRpc = walletRpcFixture('solana');
      await timed(wallet.readRpc(batchRpc.endpoint, batchRpc.fetcher), 'Explicit full batch RPC read');
      assert.equal(batchRpc.calls.filter((call) => call.method === 'simulateTransaction').length, 3);
      for (let index = 0; index < fixtures.length; index++) {
        const current = await timed(request.promise, 'Individual batch review');
        assert.equal(current.method, 'solana_signAllTransactions');
        assert.deepEqual(current.batch, { index: index + 1, total: fixtures.length });
        assert.ok(current.review.chain === 'solana');
        assert.equal(current.review.messageHex, bytesToHex(fixtures[index]!.message));
        assert.equal(device.counts().signatures, before + index); assert.equal(returned, false);
        request = deferred();
        const pin = new TextEncoder().encode('123456'); await timed(wallet.sign(pin), 'Individual batch signature');
        assert.ok(pin.every((byte) => byte === 0));
      }
      const result = await batchResult;
      assert.deepEqual(Object.keys(result), ['transactions']); assert.equal(result.transactions.length, 3);
      result.transactions.forEach((encoded, index) => {
        const transaction = getTransactionDecoder().decode(base64.decode(encoded));
        const original = getTransactionDecoder().decode(fixtures[index]!.bytes);
        assert.deepEqual(new Uint8Array(transaction.messageBytes), new Uint8Array(fixtures[index]!.message));
        assert.deepEqual([...Object.values(transaction.signatures)[1]!], [...Object.values(original.signatures)[1]!]);
        assert.ok(ed25519.verify(new Uint8Array(Object.values(transaction.signatures)[0]!), fixtures[index]!.message, base58.decode(account.address), { zip215: false }));
      });
      assert.equal(device.counts().signatures, before + 3);
      cases.push({ coin, method: 'solana_signAllTransactions', variant: 'legacy + v0 + v1 / whole-batch RPC / ALT / partial multisig / separate approvals', verified: true });

      stage = 'solana batch rejection after first signature'; console.log(stage);
      request = deferred();
      const denied = dapp.request({ topic: session.topic, chainId, request: { method: 'solana_signAllTransactions', params } }).then(
        () => { throw new Error('Partially approved batch returned success'); }, (error: unknown) => error);
      await timed(request.promise, 'First rejected-batch review');
      request = deferred();
      await timed(wallet.sign(new TextEncoder().encode('123456')), 'First rejected-batch signature');
      const second = await timed(request.promise, 'Second rejected-batch review');
      assert.deepEqual(second.batch, { index: 2, total: 3 });
      await timed(wallet.reject(), 'Reject remaining batch');
      const rejection = await timed(denied, 'Batch rejection response');
      assert.equal((rejection as { code?: number }).code, 4001);
      assert.equal(device.counts().signatures, before + 4);
      cases.push({ coin, method: 'solana_signAllTransactions', variant: 'reject after first signature / no partial response', verified: true });
    }
    stage = `${coin} rejection`;
    request = deferred();
    const params = coin === 'evm' ? ['0x6869', account.address] : { transaction: base64.encode(solanaFixture().bytes), pubkey: account.address };
    const method = coin === 'evm' ? 'personal_sign' : 'solana_signTransaction';
    const denied = dapp.request({ topic: session.topic, chainId, request: { method, params } }).then(
      () => { throw new Error('Rejected request returned a success'); }, (error: unknown) => error);
    const before = device.counts().signatures;
    await timed(request.promise, 'Rejected request review'); await timed(wallet.reject(), 'Reject request');
    const rejection = await timed(denied, 'Rejection response');
    assert.equal((rejection as { code?: number }).code, 4001);
    assert.equal(device.counts().signatures, before);
    cases.push({ coin, method: 'reject', verified: true });
    stage = `${coin} disconnect`;
    const deleted = deferred<void>();
    dapp.on('session_delete', () => deleted.resolve());
    wallet.invalidate(); await timed(deleted.promise, 'Disconnect notification');
    assert.equal(dapp.session.getAll().length, 0);
    assert.equal(device.counts().blocked, false);
    assert.equal(device.counts().cleanup, device.counts().verifications * 2);
    cases.push({ coin, method: 'disconnect', verified: true });
  } finally { wallet.invalidate(); }
}

const startedAt = new Date().toISOString();
const hardDeadline = setTimeout(() => { console.error('Relay test exceeded 150 seconds'); process.exit(2); }, 150000);
let status = 'passed', errorMessage: string | undefined;
try { await run('evm'); await run('solana'); }
catch (error) {
  status = 'failed';
  errorMessage = (error instanceof Error ? error.message : String(error)).replace(/(auth|symKey)=[^&\s]+/g, '$1=[redacted]').replace(/wc:[^\s]+/g, '[pairing URI redacted]').slice(0, 500);
} finally {
  await Promise.allSettled(clients.map(async (client) => {
    await timed(client.core.relayer.transportClose(), 'Close relay'); client.core.heartbeat.stop();
  }));
}
const report = { status, startedAt, finishedAt: new Date().toISOString(), sdk: '2.26.0', relay: 'wss://relay.walletconnect.org',
  device: 'simulated OpenPGP with dedicated synthetic keys', rpc: 'simulated remote state through production RPC transport and review paths', cases, ...(errorMessage ? { stage, error: errorMessage } : {}) };
if (process.argv[2]) { const path = resolve(process.argv[2]); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2)); clearTimeout(hardDeadline);
process.exit(status === 'passed' ? 0 : 1);
