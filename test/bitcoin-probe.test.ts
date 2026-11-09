import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p2sh, p2wpkh, RawTx, SigHash, Transaction } from '@scure/btc-signer';
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js';
import { probeBitcoinExternalSigning } from '../src/chains/bitcoin/probe.js';

// Dedicated synthetic keys. These fixtures have never represented funded UTXOs.
const secret = new Uint8Array(32).fill(1);
const otherSecret = new Uint8Array(32).fill(2);
const publicKey = secp256k1.getPublicKey(secret);
const otherPublicKey = secp256k1.getPublicKey(otherSecret);
const parseOptions = { unknown: 'ignore', proprietary: 'ignore' } as const;
const sign = async (digest: Uint8Array) => secp256k1.sign(digest, secret, { prehash: false });

function fixture(wrapped = false) {
  const native = p2wpkh(publicKey);
  const payment = wrapped ? p2sh(native) : native;
  const previous = new Transaction();
  previous.addInput({ txid: new Uint8Array(32).fill(0x42), index: 3 });
  previous.addOutput({ script: payment.script, amount: 60_000n });
  previous.addOutput({ script: p2wpkh(otherPublicKey).script, amount: 40_000n });
  const transaction = new Transaction({ ...parseOptions, lockTime: 123 });
  transaction.addInput({
    txid: previous.id,
    index: 0,
    sequence: 0xffff_fffd,
    nonWitnessUtxo: previous.toBytes(false, false),
    witnessUtxo: { amount: 60_000n, script: payment.script },
    ...(wrapped ? { redeemScript: native.script } : {}),
  });
  transaction.addInput({
    txid: previous.id,
    index: 1,
    sequence: 0xffff_fffe,
    nonWitnessUtxo: previous.toBytes(false, false),
    witnessUtxo: { amount: 40_000n, script: p2wpkh(otherPublicKey).script },
  });
  transaction.addOutput({ script: p2wpkh(otherPublicKey).script, amount: 95_000n });
  transaction.signIdx(otherSecret, 1);
  const raw = RawPSBTV0.decode(transaction.toPSBT(0));
  raw.global.unknown = [[{ type: 0xfa, key: new Uint8Array([1]) }, new Uint8Array([7, 8])]];
  raw.global.proprietary = [[new Uint8Array([1, 112, 0]), new Uint8Array([9])]];
  raw.inputs[0]!.unknown = [[{ type: 0xfa, key: new Uint8Array([2]) }, new Uint8Array([6])]];
  raw.outputs[0]!.unknown = [[{ type: 0xfa, key: new Uint8Array([3]) }, new Uint8Array([5])]];
  return { psbt: RawPSBTV0.encode(raw), previous };
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function sha256d(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();
}

// Separate BIP143 assembly with Node's SHA256, without btc-signer's sighash API.
function referenceDigest(previousTxid: string): Buffer {
  const txid = Buffer.from(previousTxid, 'hex').reverse();
  const hash160 = createHash('ripemd160')
    .update(createHash('sha256').update(publicKey).digest()).digest();
  const scriptCode = Buffer.concat([Buffer.from('76a914', 'hex'), hash160, Buffer.from('88ac', 'hex')]);
  const output = p2wpkh(otherPublicKey).script;
  return sha256d(Buffer.concat([
    u32(2),
    sha256d(Buffer.concat([txid, u32(0), txid, u32(1)])),
    sha256d(Buffer.concat([u32(0xffff_fffd), u32(0xffff_fffe)])),
    txid, u32(0), Buffer.from([scriptCode.length]), scriptCode,
    u64(60_000n), u32(0xffff_fffd),
    sha256d(Buffer.concat([u64(95_000n), Buffer.from([output.length]), output])),
    u32(123), u32(SigHash.ALL),
  ]));
}

for (const wrapped of [false, true]) {
  test(`Bitcoin P0 ${wrapped ? 'P2SH-P2WPKH' : 'P2WPKH'} external signature matches BIP143 and software signer`, async () => {
    const { psbt, previous } = fixture(wrapped);
    const before = RawPSBTV0.decode(psbt);
    const untouched = Uint8Array.from(psbt);
    const signed = await probeBitcoinExternalSigning(psbt, 0, publicKey, async (digest) => {
      assert.deepEqual(Buffer.from(digest), referenceDigest(previous.id));
      return sign(digest);
    });
    assert.deepEqual(psbt, untouched);
    assert.deepEqual(Buffer.from(signed.digest), referenceDigest(previous.id));
    const result = Transaction.fromPSBT(signed.psbt, parseOptions);
    const expected = Transaction.fromPSBT(psbt, parseOptions);
    expected.signIdx(secret, 0);
    assert.deepEqual(result.getInput(0).partialSig, expected.getInput(0).partialSig);
    assert.deepEqual(result.getInput(1).partialSig, before.inputs[1]!.partialSig);
    const after = RawPSBTV0.decode(signed.psbt);
    assert.deepEqual(after.global, before.global);
    assert.deepEqual(after.outputs, before.outputs);
    assert.deepEqual(after.inputs[0]!.unknown, before.inputs[0]!.unknown);
    assert.deepEqual(result.toPSBT(0), signed.psbt);
    result.finalize();
    assert.equal(result.isFinal, true);
    const extracted = RawTx.decode(result.extract());
    assert.equal(extracted.witnesses?.length, 2);
    assert.equal(extracted.witnesses?.[0]?.length, 2);
  });
}

test('Bitcoin P0 normalizes hardware high-S signatures and verifies before attachment', async () => {
  const { psbt } = fixture();
  const signed = await probeBitcoinExternalSigning(psbt, 0, publicKey, async (digest) => {
    const low = secp256k1.Signature.fromBytes(await sign(digest));
    return new secp256k1.Signature(low.r, secp256k1.Point.Fn.ORDER - low.s).toBytes('compact');
  });
  const bytes = Transaction.fromPSBT(signed.psbt, parseOptions).getInput(0).partialSig![0]![1];
  assert.equal(bytes.at(-1), SigHash.ALL);
  assert.equal(secp256k1.Signature.fromBytes(bytes.subarray(0, -1), 'der').hasHighS(), false);
  assert.equal(secp256k1.verify(bytes.subarray(0, -1), signed.digest, publicKey, {
    prehash: false, format: 'der',
  }), true);
});

test('Bitcoin P0 rejects invalid returned signatures', async () => {
  const { psbt } = fixture();
  await assert.rejects(probeBitcoinExternalSigning(psbt, 0, publicKey, async (digest) =>
    secp256k1.sign(digest, otherSecret, { prehash: false })), /does not verify/);
  await assert.rejects(probeBitcoinExternalSigning(psbt, 0, publicKey, async () =>
    new Uint8Array(63)), /64-byte/);
});

test('Bitcoin P0 rejects ambiguous or unsupported signing inputs before callback', async () => {
  const { psbt } = fixture();
  let calls = 0;
  const unexpectedSigner = async () => { calls++; return new Uint8Array(64); };
  const noPrevious = RawPSBTV0.decode(psbt);
  delete noPrevious.inputs[1]!.nonWitnessUtxo;
  await assert.rejects(probeBitcoinExternalSigning(
    RawPSBTV0.encode(noPrevious), 0, publicKey, unexpectedSigner,
  ), /full previous transactions/);
  const specialSighash = RawPSBTV0.decode(psbt);
  specialSighash.inputs[0]!.sighashType = SigHash.NONE;
  await assert.rejects(probeBitcoinExternalSigning(
    RawPSBTV0.encode(specialSighash), 0, publicKey, unexpectedSigner,
  ), /SIGHASH_ALL/);
  await assert.rejects(probeBitcoinExternalSigning(psbt, 0, otherPublicKey, unexpectedSigner), /matching/);
  await assert.rejects(probeBitcoinExternalSigning(psbt, -1, publicKey, unexpectedSigner), /input index/);
  await assert.rejects(probeBitcoinExternalSigning(psbt, 0.5, publicKey, unexpectedSigner), /input index/);
  await assert.rejects(probeBitcoinExternalSigning(psbt, 0, publicKey.slice(1), unexpectedSigner), /compressed/);
  const version2 = Transaction.fromPSBT(psbt, parseOptions).toPSBT(2);
  await assert.rejects(probeBitcoinExternalSigning(version2, 0, publicKey, unexpectedSigner));
  await assert.rejects(probeBitcoinExternalSigning(psbt.subarray(0, -1), 0, publicKey, unexpectedSigner));
  await assert.rejects(probeBitcoinExternalSigning(new Uint8Array(1_048_577), 0, publicKey, unexpectedSigner), /1 MiB/);
  assert.equal(calls, 0);
});

test('Bitcoin P0 rejects forged UTXOs and script mismatches before callback', async () => {
  const { psbt } = fixture(true);
  let calls = 0;
  const unexpectedSigner = async () => { calls++; return new Uint8Array(64); };
  const wrongAmount = RawPSBTV0.decode(psbt);
  wrongAmount.inputs[0]!.witnessUtxo!.amount += 1n;
  await assert.rejects(probeBitcoinExternalSigning(
    RawPSBTV0.encode(wrongAmount), 0, publicKey, unexpectedSigner,
  ), /different from nonWitnessUtxo/);
  const wrongTxid = RawPSBTV0.decode(psbt);
  wrongTxid.global.unsignedTx!.inputs[0]!.txid[0] ^= 1;
  await assert.rejects(probeBitcoinExternalSigning(
    RawPSBTV0.encode(wrongTxid), 0, publicKey, unexpectedSigner,
  ), /wrong txid/);
  const wrongRedeem = RawPSBTV0.decode(psbt);
  wrongRedeem.inputs[0]!.redeemScript = p2wpkh(otherPublicKey).script;
  await assert.rejects(probeBitcoinExternalSigning(
    RawPSBTV0.encode(wrongRedeem), 0, publicKey, unexpectedSigner,
  ));
  assert.equal(calls, 0);
});

test('Bitcoin P0 preserves the captured PSBT and key across asynchronous signing', async () => {
  const { psbt } = fixture();
  const captured = Uint8Array.from(psbt);
  const mutableKey = Uint8Array.from(publicKey);
  const signed = await probeBitcoinExternalSigning(psbt, 0, mutableKey, async (digest) => {
    const signature = await sign(digest);
    psbt.fill(0);
    mutableKey.fill(0);
    digest.fill(0);
    return signature;
  });
  const result = RawPSBTV0.decode(signed.psbt);
  assert.deepEqual(result.global, RawPSBTV0.decode(captured).global);
  assert.deepEqual(result.inputs[0]!.partialSig![0]![0], publicKey);
  await assert.rejects(probeBitcoinExternalSigning(signed.psbt, 0, publicKey, sign), /already has a signature/);
});
