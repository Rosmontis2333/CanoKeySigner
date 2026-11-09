import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Transaction } from '@scure/btc-signer';
import { RawPSBTV0, RawPSBTV2 } from '@scure/btc-signer/psbt.js';
import { decodeRawPsbt } from '../src/chains/bitcoin/psbt';
import { prepareBitcoinTransaction, attachBitcoinSignatures, finalizeBitcoinTransaction } from '../src/chains/bitcoin/transaction';
import { bitcoinFixture, bitcoinV2Fixture, bitcoinPublic, bitcoinSecret } from './fixtures/bitcoin';

const publicKeyHex = bytesToHex(bitcoinPublic);
const options = { unknown: 'ignore', proprietary: 'ignore' } as const;
const sign = (digest: string) => bytesToHex(secp256k1.sign(hexToBytes(digest), bitcoinSecret, { prehash: false }));
const vectors = JSON.parse(readFileSync(new URL('./fixtures/bip370.json', import.meta.url), 'utf8')) as {
  invalid: { name: string; hex: string }[];
  valid: { name: string; hex: string }[];
  locktime: { name: string; hex: string; locktime: number | null }[];
};

test('BIP370 official invalid and valid PSBT vectors pass through the production format decoder', () => {
  assert.equal(vectors.invalid.length, 24); assert.equal(vectors.valid.length, 14);
  for (const vector of vectors.invalid) assert.throws(() => decodeRawPsbt(hexToBytes(vector.hex)), vector.name);
  for (const vector of vectors.valid) {
    const { raw, version, coder } = decodeRawPsbt(hexToBytes(vector.hex));
    assert.equal(version, 2, vector.name);
    assert.deepEqual(coder.decode(coder.encode(raw)), raw, vector.name);
  }
});

test('BIP370 official locktime determination vectors match the production transaction path', () => {
  assert.equal(vectors.locktime.length, 10);
  for (const vector of vectors.locktime) {
    const bytes = hexToBytes(vector.hex);
    decodeRawPsbt(bytes);
    if (vector.locktime === null) assert.throws(() => Transaction.fromPSBT(bytes, options), vector.name);
    else assert.equal(Transaction.fromPSBT(bytes, options).lockTime, vector.locktime, vector.name);
  }
});

for (const wrapped of [false, true]) {
  test(`PSBT v2 ${wrapped ? 'wrapped' : 'native'} signs owned inputs, retains fields and extracts the same transaction as v0`, () => {
    const v0 = bitcoinFixture(wrapped, 2), v2 = bitcoinV2Fixture(wrapped, 2);
    const before = RawPSBTV2.decode(v2);
    before.outputs[0]!.unknown = [[{ type: 0xfa, key: Uint8Array.of(8) }, Uint8Array.of(9, 10)]];
    for (const map of [before.global, before.inputs[0]!, before.outputs[0]!]) {
      map.proprietary = [[Uint8Array.of(3, 0x66, 0x6f, 0x6f, 1, 0xab), Uint8Array.of(0, 1, 2)]];
    }
    const source = RawPSBTV2.encode(before);
    const review = prepareBitcoinTransaction(base64.encode(source), publicKeyHex, 'testnet');
    const reference = prepareBitcoinTransaction(base64.encode(v0), publicKeyHex, 'testnet');
    assert.equal(review.psbtVersion, 2); assert.deepEqual(review.jobs, reference.jobs);
    assert.ok(review.rows.some(([name, value]) => name === 'PSBT 版本' && value === '2'));
    assert.ok(review.rows.some(([name, value]) => name === '交付格式' && value.includes('v2')));
    const signed = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
    const after = RawPSBTV2.decode(signed);
    assert.deepEqual(after.global, before.global);
    assert.deepEqual(after.outputs, before.outputs);
    assert.deepEqual(after.inputs[2], before.inputs[2]);
    for (let i = 0; i < 2; i++) assert.deepEqual(after.inputs[i]!.unknown, before.inputs[i]!.unknown);
    const originalSigned = attachBitcoinSignatures(reference, reference.jobs.map((job) => sign(job.digestHex)));
    assert.deepEqual(finalizeBitcoinTransaction(review, signed), finalizeBitcoinTransaction(reference, originalSigned));
    assert.equal(prepareBitcoinTransaction(base64.encode(signed), publicKeyHex, 'testnet').signable, false);
    assert.throws(() => finalizeBitcoinTransaction(review, originalSigned), /版本/);
  });
}

test('PSBT v2 clears only the input/output modification permissions after SIGHASH_ALL', () => {
  for (const flags of [undefined, 0, 1, 2, 3, 4, 5, 6, 7]) {
    const raw = RawPSBTV2.decode(bitcoinV2Fixture());
    if (flags === undefined) delete raw.global.txModifiable;
    else raw.global.txModifiable = flags;
    const source = RawPSBTV2.encode(raw);
    const review = prepareBitcoinTransaction(base64.encode(source), publicKeyHex, 'mainnet');
    const signed = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
    const result = RawPSBTV2.decode(signed);
    assert.equal(result.global.txModifiable, flags === undefined ? undefined : flags & ~3);
    assert.deepEqual(result.global.unknown, raw.global.unknown);
    assert.ok(finalizeBitcoinTransaction(review, signed).length);
    result.global.txModifiable = 3;
    assert.throws(() => finalizeBitcoinTransaction(review, RawPSBTV2.encode(result)), /变化/);
  }
  const raw = RawPSBTV2.decode(bitcoinV2Fixture()); raw.global.txModifiable = 8;
  assert.throws(() => prepareBitcoinTransaction(base64.encode(RawPSBTV2.encode(raw)), publicKeyHex, 'mainnet'), /未知/);
});

test('PSBT v2 preserves optional omissions, explicit zero fields and locktime requirements', () => {
  const raw = RawPSBTV2.decode(bitcoinV2Fixture());
  delete raw.global.fallbackLocktime;
  delete raw.global.txModifiable;
  delete raw.inputs[0]!.sequence;
  raw.inputs[0]!.requiredHeightLocktime = 10000;
  raw.inputs[1]!.requiredHeightLocktime = 9000;
  raw.inputs[1]!.requiredTimeLocktime = 1657048460;
  delete raw.inputs[1]!.partialSig;
  const updated = Transaction.fromPSBT(RawPSBTV2.encode(raw), options);
  updated.signIdx(new Uint8Array(32).fill(3), 1);
  const before = RawPSBTV2.decode(updated.toPSBT(2));
  delete before.global.fallbackLocktime;
  delete before.global.txModifiable;
  delete before.inputs[0]!.sequence;
  const source = RawPSBTV2.encode(before);
  const review = prepareBitcoinTransaction(base64.encode(source), publicKeyHex, 'mainnet');
  assert.ok(review.rows.some(([name, value]) => name === 'locktime' && value === '10000'));
  assert.ok(review.rows.some(([name, value]) => name === '输入 1 / 最早时间（Unix 秒）' && value === '1657048460'));
  const result = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
  const after = RawPSBTV2.decode(result);
  assert.equal(after.global.fallbackLocktime, undefined);
  assert.equal(after.global.txModifiable, undefined);
  assert.equal(after.inputs[0]!.sequence, undefined);
  assert.equal(after.inputs[0]!.requiredHeightLocktime, 10000);
  assert.equal(after.inputs[1]!.requiredTimeLocktime, before.inputs[1]!.requiredTimeLocktime);
  assert.equal(Transaction.fromRaw(finalizeBitcoinTransaction(review, result)).lockTime, 10000);
  after.inputs[0]!.requiredHeightLocktime = 10001;
  assert.throws(() => finalizeBitcoinTransaction(review, RawPSBTV2.encode(after)));
});

test('PSBT v0 explicit version zero and empty optional records survive signature attachment', () => {
  const raw = RawPSBTV0.decode(bitcoinFixture());
  raw.global.version = 0;
  raw.inputs[0]!.porCommitment = new Uint8Array();
  const source = RawPSBTV0.encode(raw);
  const review = prepareBitcoinTransaction(base64.encode(source), publicKeyHex, 'mainnet');
  const signed = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
  const after = RawPSBTV0.decode(signed);
  assert.equal(after.global.version, 0);
  assert.deepEqual(after.inputs[0]!.porCommitment, new Uint8Array());
  assert.ok(finalizeBitcoinTransaction(review, signed).length);
});

test('PSBT v2 bounds count framing before map decoding and rejects duplicates, noncanonical lengths and truncation', () => {
  const raw = RawPSBTV2.decode(bitcoinV2Fixture()), source = RawPSBTV2.encode(raw);
  const hex = bytesToHex(source);
  for (const corrupted of [
    hex.replace('01040102', '010403fd8100'), // 129 input maps
    hex.replace('01040102', '010405feffffffff'),
    hex.replace('01040102', '010409ffffffffffffffffff'),
    hex.replace('01040102', '010403fd0200'), // non-minimal CompactSize
    hex.replace('01050101', '0105010101050101'), // duplicate count
    hex.replace('01fb0402000000', '01fb0403000000'),
  ]) {
    assert.notEqual(corrupted, hex);
    assert.throws(() => decodeRawPsbt(hexToBytes(corrupted)));
  }
  for (const length of [0, 4, 5, 10, source.length - 1]) assert.throws(() => decodeRawPsbt(source.slice(0, length)));
  assert.throws(() => decodeRawPsbt(Uint8Array.from([...source, 0])));
  // Unrelated unknown fields use the same complete map validation as known fields.
  raw.global.unknown!.push(raw.global.unknown![0]!);
  assert.throws(() => RawPSBTV2.encode(raw));
});
