import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicKey, verify } from 'node:crypto';
import { base58, base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getCompiledTransactionMessageDecoder } from '@solana/transaction-messages';
import { getTransactionEncoder, getTransactionDecoder } from '@solana/transactions';
import type { V1TransactionConfig } from '@solana/transaction-messages';
import { parseV1Message } from '../src/chains/solana/v1';
import { prepareSolanaTransaction, attachSolanaSignature } from '../src/chains/solana/transaction';
import { approveSolanaTransaction } from '../src/signing/approval';
import { executeReviewedTransaction } from '../src/signing/execute';
import { solanaV1Fixture, encodeV1Fixture } from './fixtures/solana-v1';
import { solanaSigner, solanaOther, solanaSeed } from './fixtures/solana';
import { relayDevice } from './fixtures/relay-device';

const publicKeyHex = bytesToHex(solanaSigner.publicKey.toBytes());
const nodeKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'), solanaSigner.publicKey.toBuffer(),
]) });
const memo = (length: number) => new TransactionInstruction({
  programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.alloc(length, 0x61),
});
const reviewBytes = (bytes: Uint8Array) => prepareSolanaTransaction(base64.encode(bytes), publicKeyHex, 'devnet');

for (let mask = 0; mask <= 31; mask++) {
  if ((mask & 3) === 1 || (mask & 3) === 2) continue;
  test(`Solana v1 config mask ${mask} matches official Kit 8.6.0 codecs and Node Ed25519`, () => {
    const config: V1TransactionConfig = {
      ...(mask & 3 ? { priorityFeeLamports: 18446744073709551615n } : {}),
      ...(mask & 4 ? { computeUnitLimit: 200000 } : {}),
      ...(mask & 8 ? { loadedAccountsDataSizeLimit: 67108864 } : {}),
      ...(mask & 16 ? { heapSize: 65536 } : {}),
    };
    for (const multi of [false, true]) {
      const fixture = solanaV1Fixture(multi, config);
      const message = parseV1Message(fixture.message);
      assert.equal(message.resources.mask, mask);
      assert.equal(message.resources.priorityFee, config.priorityFeeLamports ?? 0n);
      assert.equal(message.resources.computeUnitLimit, config.computeUnitLimit ?? 0);
      assert.equal(message.resources.loadedAccountsDataLimit, config.loadedAccountsDataSizeLimit ?? 0);
      assert.equal(message.resources.heapSize, config.heapSize ?? 32768);
      const review = reviewBytes(fixture.bytes);
      assert.equal(review.version, 'v1'); assert.equal(review.signable, true);
      assert.equal(review.signatureOffset, fixture.message.length);
      assert.equal(review.messageHex, bytesToHex(fixture.message));
      const signature = ed25519.sign(fixture.message, solanaSeed);
      assert.ok(verify(null, fixture.message, nodeKey, signature));
      const signed = attachSolanaSignature(review, signature);
      const decoded = getTransactionDecoder().decode(signed);
      assert.deepEqual(new Uint8Array(decoded.messageBytes), fixture.message);
      if (multi) {
        const key = solanaOther.publicKey.toBase58() as keyof typeof decoded.signatures;
        assert.deepEqual([...decoded.signatures[key]!], [...fixture.transaction.signatures[key]!]);
      }
      const expected = getTransactionEncoder().encode({ ...fixture.transaction,
        signatures: { ...fixture.transaction.signatures, [solanaSigner.publicKey.toBase58()]: signature } });
      assert.deepEqual(signed, new Uint8Array(expected));
    }
  });
}

test('Solana v1 manual message encodings retain the prefix and reconstruct signatures at the tail', () => {
  const fixture = solanaV1Fixture();
  for (const encoding of ['base64', 'base58', 'hex']) {
    const source = encoding === 'base64' ? base64.encode(fixture.message) : encoding === 'base58' ? base58.encode(fixture.message) : bytesToHex(fixture.message);
    const review = prepareSolanaTransaction(source, publicKeyHex, 'devnet', encoding, 'message');
    assert.equal(review.transactionHex, bytesToHex(fixture.bytes));
    assert.equal(review.messageHex, bytesToHex(fixture.message));
    assert.equal(review.signable, true);
  }
});

test('Solana v1 supports a selected signer at a nonzero tail offset and preserves the fee payer signature', () => {
  const fixture = solanaV1Fixture(true);
  const original = fixture.bytes.slice();
  const payerSignature = ed25519.sign(fixture.message, solanaSeed);
  original.set(payerSignature, fixture.message.length);
  original.fill(0, fixture.message.length + 64);
  const review = prepareSolanaTransaction(base64.encode(original), bytesToHex(solanaOther.publicKey.toBytes()), 'devnet');
  assert.equal(review.signerIndex, 1);
  const signature = ed25519.sign(fixture.message, solanaOther.secretKey.slice(0, 32));
  const signed = attachSolanaSignature(review, signature);
  assert.deepEqual(signed.slice(fixture.message.length, fixture.message.length + 64), payerSignature);
  assert.deepEqual(signed.slice(fixture.message.length + 64), signature);
});

test('Solana v1 ComputeBudget instructions are no-ops even with empty, malformed or duplicate data', () => {
  const programId = new PublicKey('ComputeBudget111111111111111111111111111111');
  const instructions = [Buffer.alloc(0), Buffer.of(255), Buffer.of(3), Buffer.of(3)].map((data) => new TransactionInstruction({ programId, keys: [], data }));
  const fixture = solanaV1Fixture(false, { priorityFeeLamports: 77n, computeUnitLimit: 100000, loadedAccountsDataSizeLimit: 1048576 }, instructions);
  const review = reviewBytes(fixture.bytes);
  assert.equal(review.signable, true);
  assert.equal(review.rows.filter(([, value]) => value === 'v1 ComputeBudget no-op').length, 4);
  assert.ok(review.rows.some(([label, value]) => label === 'v1 Priority fee（总 lamports）' && value === '77（显式）'));
  assert.ok(!review.rows.some(([label]) => label === '显式 CU 配置优先费（lamports）'));
});

test('Solana v1 parses the complete protocol capacity and only approves messages within the 1331-byte device limit', async () => {
  const base = solanaV1Fixture(false, {}, [memo(0)]);
  for (const length of [1331, 1332, 4032]) {
    const size = length - base.message.length;
    const compiled = { ...base.compiled, instructionHeaders: [{ ...base.compiled.instructionHeaders[0]!, numInstructionDataBytes: size }],
      instructionPayloads: [{ instructionAccountIndices: [], instructionData: new Uint8Array(size).fill(0x61) }] };
    const fixture = encodeV1Fixture(compiled);
    assert.equal(fixture.message.length, length);
    const review = reviewBytes(fixture.bytes);
    assert.equal(review.signable, length <= 1331);
    assert.equal(review.rows.find(([label]) => label === '消息字节数')![1], String(length));
    if (length > 1331) {
      assert.throws(() => approveSolanaTransaction(review, relayDevice('solana').account.slot));
      continue;
    }
    const device = relayDevice('solana'), pin = new TextEncoder().encode('123456');
    const result = await executeReviewedTransaction(device.access, review, device.account.slot, pin);
    assert.equal(result.authenticationCleared, true); assert.ok(pin.every((byte) => byte === 0));
    const decoded = getTransactionDecoder().decode(base64.decode(result.output));
    const signature = Object.values(decoded.signatures)[0]!;
    assert.ok(verify(null, fixture.message, nodeKey, signature));
    assert.deepEqual(new Uint8Array(decoded.messageBytes), fixture.message);
  }
  const oversized = { ...base.compiled, instructionHeaders: [{ ...base.compiled.instructionHeaders[0]!, numInstructionDataBytes: 4033 - base.message.length }],
    instructionPayloads: [{ instructionAccountIndices: [], instructionData: new Uint8Array(4033 - base.message.length).fill(0x61) }] };
  assert.throws(() => reviewBytes(encodeV1Fixture(oversized).bytes));
});

test('Solana v1 validates all truncation points, extra bytes, masks, header counts and instruction indices', () => {
  const fixture = solanaV1Fixture();
  for (let index = 0; index < fixture.bytes.length; index++) assert.throws(() => reviewBytes(fixture.bytes.slice(0, index)), `cut ${index}`);
  assert.throws(() => reviewBytes(Uint8Array.from([...fixture.bytes, 0])));
  const mutations: ((bytes: Buffer) => void)[] = [
    (bytes) => { bytes[0] = 0x82; }, (bytes) => { bytes[1] = 0; }, (bytes) => { bytes[1] = 13; },
    (bytes) => { bytes[2] = bytes[1]!; }, (bytes) => { bytes[3] = 255; },
    (bytes) => { bytes.writeUInt32LE(1, 4); }, (bytes) => { bytes.writeUInt32LE(2, 4); },
    (bytes) => { bytes.writeUInt32LE(32, 4); }, (bytes) => { bytes.writeUInt32LE(0xffffffff, 4); },
    (bytes) => { bytes[40] = 65; }, (bytes) => { bytes[41] = 0; }, (bytes) => { bytes[41] = 97; },
    (bytes) => { bytes[42 + bytes[41]! * 32 + 16] = 0; },
    (bytes) => { bytes[42 + bytes[41]! * 32 + 16] = bytes[41]!; },
    (bytes) => { bytes[42 + bytes[41]! * 32 + 16 + 4] = bytes[41]!; },
  ];
  for (const mutate of mutations) {
    const message = Buffer.from(fixture.message); mutate(message);
    assert.throws(() => prepareSolanaTransaction(message.toString('base64'), publicKeyHex, 'devnet', 'base64', 'message'));
  }
});

test('Solana v1 rejects invalid heap configurations and duplicate addresses before approval', () => {
  for (const heapSize of [0, 32767, 32769, 263168]) {
    const fixture = solanaV1Fixture(false, { heapSize });
    assert.throws(() => reviewBytes(fixture.bytes), /heap/);
  }
  for (const heapSize of [32768, 262144]) assert.equal(reviewBytes(solanaV1Fixture(false, { heapSize }).bytes).signable, true);
  const fixture = solanaV1Fixture();
  const duplicate = { ...fixture.compiled, staticAccounts: [...fixture.compiled.staticAccounts] };
  duplicate.staticAccounts[1] = duplicate.staticAccounts[0]!;
  assert.throws(() => reviewBytes(encodeV1Fixture(duplicate).bytes), /重复/);
});

test('Solana v1 reads 0/64 instructions and 96 inline accounts while rejecting protocol count overflow', () => {
  const base = solanaV1Fixture(false, {}, [memo(0)]);
  for (const count of [0, 64]) {
    const compiled = { ...base.compiled, numInstructions: count, instructionHeaders: Array(count).fill(base.compiled.instructionHeaders[0]),
      instructionPayloads: Array(count).fill(base.compiled.instructionPayloads[0]) };
    assert.equal(reviewBytes(encodeV1Fixture(compiled).bytes).signable, true);
  }
  const staticAccounts = [...base.compiled.staticAccounts];
  for (let index = 10; staticAccounts.length < 96; index++) staticAccounts.push(base58.encode(new Uint8Array(32).fill(index)) as typeof staticAccounts[number]);
  const compiled = { ...base.compiled, staticAccounts, numStaticAccounts: 96, header: { ...base.compiled.header, numReadonlyNonSignerAccounts: 95 } };
  const review = reviewBytes(encodeV1Fixture(compiled).bytes);
  assert.equal(review.signable, false); assert.ok(review.rows.some(([, value]) => value.includes('SIMD-0596')));
});

test('Solana v1 admits twelve required signers and preserves every other empty signature slot', () => {
  const base = solanaV1Fixture();
  const extra = Array.from({ length: 11 }, (_, index) => base58.encode(new Uint8Array(32).fill(index + 10)) as typeof base.compiled.staticAccounts[number]);
  const compiled = { ...base.compiled,
    header: { ...base.compiled.header, numSignerAccounts: 12, numReadonlySignerAccounts: 11 },
    staticAccounts: [base.compiled.staticAccounts[0]!, ...extra, ...base.compiled.staticAccounts.slice(1)],
    numStaticAccounts: base.compiled.numStaticAccounts + 11,
    instructionHeaders: base.compiled.instructionHeaders.map((header) => ({ ...header, programAccountIndex: header.programAccountIndex + 11 })),
    instructionPayloads: base.compiled.instructionPayloads.map((payload) => ({ ...payload,
      instructionAccountIndices: payload.instructionAccountIndices.map((index) => index ? index + 11 : 0) })),
  };
  const fixture = encodeV1Fixture(compiled), review = reviewBytes(fixture.bytes);
  assert.equal(review.signable, true);
  const signed = attachSolanaSignature(review, ed25519.sign(fixture.message, solanaSeed));
  assert.ok(signed.slice(fixture.message.length + 64).every((byte) => byte === 0));
  const decoded = getTransactionDecoder().decode(signed);
  assert.equal(Object.keys(decoded.signatures).length, 12);
});

test('Solana v1 verifies all existing signatures and refuses already signed accounts or unknown programs', () => {
  const fixture = solanaV1Fixture(true);
  const corrupt = fixture.bytes.slice(); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  assert.throws(() => reviewBytes(corrupt), /签名/);
  const signed = attachSolanaSignature(reviewBytes(fixture.bytes), ed25519.sign(fixture.message, solanaSeed));
  assert.equal(reviewBytes(signed).signable, false);
  const unknown = solanaV1Fixture(false, {}, [new TransactionInstruction({ programId: solanaOther.publicKey, keys: [], data: Buffer.of(1) })]);
  const review = reviewBytes(unknown.bytes); assert.equal(review.signable, false);
  assert.throws(() => approveSolanaTransaction(review, relayDevice('solana').account.slot));
  assert.equal(getCompiledTransactionMessageDecoder().decode(fixture.message).version, 1);
});
