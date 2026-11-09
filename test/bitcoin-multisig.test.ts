import assert from 'node:assert/strict';
import test from 'node:test';
import { base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Transaction, p2ms, p2sh, p2wsh, p2wpkh } from '@scure/btc-signer';
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js';
import { Psbt, Transaction as ReferenceTransaction, payments, networks, crypto } from 'bitcoinjs-lib';
import type { P2Ret } from '@scure/btc-signer/payment.js';
import { prepareBitcoinTransaction, attachBitcoinSignatures, finalizeBitcoinTransaction } from '../src/chains/bitcoin/transaction';
import { decodeRawPsbt } from '../src/chains/bitcoin/psbt';
import { accountAddresses } from '../src/ui/accounts';
import { executeReviewedTransaction } from '../src/signing/execute';
import { relayDevice } from './fixtures/relay-device';
import { bitcoinPublic, bitcoinSecret } from './fixtures/bitcoin';
import { bitcoinTemplateFixture, bitcoinTemplates, cosignerSecret } from './fixtures/bitcoin-multisig';

const publicKeyHex = bytesToHex(bitcoinPublic);
const sign = (digest: string) => bytesToHex(secp256k1.sign(hexToBytes(digest), bitcoinSecret, { prehash: false }));
const validator = (key: Uint8Array, digest: Uint8Array, signature: Uint8Array) => secp256k1.verify(signature, digest, key, { prehash: false, lowS: false });

for (const version of [0, 2] as const) for (const template of bitcoinTemplates) {
  test(`Bitcoin PSBT v${version} ${template} matches independent digest and finalized transaction`, () => {
    const fixture = bitcoinTemplateFixture([template], version);
    const review = prepareBitcoinTransaction(base64.encode(fixture.bytes), publicKeyHex, 'testnet');
    assert.equal(review.jobs.length, 1);
    assert.equal(review.psbtVersion, version);
    const payment = fixture.descriptors[0]!.payment;
    const reference = ReferenceTransaction.fromBuffer(fixture.psbt.data.globalMap.unsignedTx.toBuffer());
    const legacy = template.endsWith('pkh') || template === 'sh-ms' || template === 'uncompressed-sh-ms';
    const script = template.endsWith('pkh') ? payment.output! : template === 'sh-wsh-ms'
      ? payment.redeem!.redeem!.output! : payment.redeem!.output!;
    const expectedDigest = legacy ? reference.hashForSignature(0, script, ReferenceTransaction.SIGHASH_ALL)
      : reference.hashForWitnessV0(0, script, 100000n, ReferenceTransaction.SIGHASH_ALL);
    assert.equal(review.jobs[0]!.digestHex, bytesToHex(expectedDigest));
    assert.equal(hexToBytes(review.jobs[0]!.publicKeyHex).length, template.startsWith('uncompressed') ? 65 : 33);
    assert.ok(review.rows.some(([label, value]) => label === '输出 0 / 所有权' && value === '已验证匹配本机公钥'));
    if (!template.endsWith('pkh')) {
      assert.ok(review.rows.some(([label, value]) => label === '输入 0 / 多签门槛' && value === '2 / 3'));
      assert.ok(review.rows.some(([label, value]) => label === '输入 0 / 公钥顺序' && value === fixture.descriptors[0]!.keys.map(bytesToHex).join('\n')));
    }
    const signed = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
    const { raw: before } = decodeRawPsbt(fixture.bytes), { raw: after } = decodeRawPsbt(signed);
    assert.deepEqual(after.global, { ...before.global, ...(version === 2 && before.global.txModifiable !== undefined
      ? { txModifiable: before.global.txModifiable & ~3 } : {}) });
    assert.deepEqual(after.outputs, before.outputs);
    assert.deepEqual(after.inputs[0]!.unknown, before.inputs[0]!.unknown);
    for (const signature of before.inputs[0]!.partialSig ?? []) assert.ok(after.inputs[0]!.partialSig!.some((row) => bytesToHex(row[0]) === bytesToHex(signature[0]) && bytesToHex(row[1]) === bytesToHex(signature[1])));
    const result = finalizeBitcoinTransaction(review, signed);
    const resultTx = ReferenceTransaction.fromBuffer(result);
    const referencePsbt = Psbt.fromBuffer(fixture.v0, { network: networks.testnet });
    referencePsbt.signInput(0, { publicKey: fixture.descriptors[0]!.keys[0]!, sign: (digest) => secp256k1.sign(digest, bitcoinSecret, { prehash: false }) });
    assert.equal(referencePsbt.validateSignaturesOfAllInputs(validator), true);
    if (template === 'uncompressed-sh-ms') {
      // bitcoinjs 7.0.5's default hasSigs compresses the script keys before matching.
      // Its payment builders retain the original uncompressed script and key ordering.
      const finalize = (_index: number, input: Psbt['data']['inputs'][number]) => {
        const redeem = payments.p2ms({ m: 2, pubkeys: fixture.descriptors[0]!.keys,
          signatures: fixture.descriptors[0]!.keys.flatMap((key) => input.partialSig?.filter((row) => bytesToHex(row.pubkey) === bytesToHex(key)).map((row) => row.signature) ?? []) });
        return { finalScriptSig: payments.p2sh({ redeem }).input, finalScriptWitness: undefined };
      };
      referencePsbt.finalizeInput(0, finalize);
    } else referencePsbt.finalizeAllInputs();
    assert.equal(resultTx.toHex(), referencePsbt.extractTransaction().toHex());
    assert.ok(resultTx.virtualSize() <= Number(new Map(review.rows).get('签名后 vsize 估计上限')));
    assert.equal(prepareBitcoinTransaction(base64.encode(signed), publicKeyHex, 'testnet').signable, false);
  });
}

test('Bitcoin mixes supported legacy, witness and multisig inputs and preserves script-specific public keys', () => {
  const fixture = bitcoinTemplateFixture(bitcoinTemplates, 2);
  const review = prepareBitcoinTransaction(base64.encode(fixture.bytes), publicKeyHex, 'testnet');
  assert.equal(review.jobs.length, bitcoinTemplates.length);
  assert.deepEqual(review.jobs.map((job) => job.index), [0, 1, 2, 3, 4, 5]);
  const signed = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
  const result = ReferenceTransaction.fromBuffer(finalizeBitcoinTransaction(review, signed));
  assert.equal(result.ins.length, bitcoinTemplates.length);
  assert.ok(result.ins[0]!.script.length > 0);
  assert.equal(result.ins[4]!.witness.length, 4);
  assert.ok(result.virtualSize() <= Number(new Map(review.rows).get('签名后 vsize 估计上限')));
  const tampered = decodeRawPsbt(signed); tampered.raw.inputs[0]!.unknown![0]![1][0] = 4;
  assert.throws(() => finalizeBitcoinTransaction(review, tampered.coder.encode(tampered.raw)), /变化/);
});

test('Bitcoin multisig stops at the actual threshold, preserves co-signatures and keeps incomplete results partial', () => {
  const fixture = bitcoinTemplateFixture(['wsh-ms'], 0, false);
  const review = prepareBitcoinTransaction(base64.encode(fixture.bytes), publicKeyHex, 'testnet');
  const signed = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
  assert.throws(() => finalizeBitcoinTransaction(review, signed), /门槛/);
  assert.equal(prepareBitcoinTransaction(base64.encode(signed), publicKeyHex, 'testnet').jobs.length, 0);
  const complete = bitcoinTemplateFixture(['wsh-ms'], 0, true, 1);
  const unnecessary = prepareBitcoinTransaction(base64.encode(complete.bytes), publicKeyHex, 'testnet');
  assert.equal(unnecessary.jobs.length, 0);
  assert.equal(unnecessary.signable, false);
  const outsider = bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(5)));
  assert.equal(prepareBitcoinTransaction(base64.encode(fixture.bytes), outsider, 'testnet').jobs.length, 0);
});

test('Bitcoin rejects forged script commitments, missing previous transactions and invalid co-signatures', () => {
  const mutations = [
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { delete raw.inputs[0]!.nonWitnessUtxo; },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[0]!.witnessUtxo!.amount++; },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[0]!.witnessScript![2] = raw.inputs[0]!.witnessScript![2]! ^ 1; },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { delete raw.inputs[0]!.witnessScript; },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[0]!.partialSig![0]![1].fill(0); },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[0]!.partialSig![0]![0] = secp256k1.getPublicKey(new Uint8Array(32).fill(5)); },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[0]!.partialSig![0]![1][raw.inputs[0]!.partialSig![0]![1].length - 1] = 2; },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[0]!.sighashType = 0x81; },
  ];
  for (const mutate of mutations) {
    const raw = RawPSBTV0.decode(bitcoinTemplateFixture(['wsh-ms']).bytes);
    mutate(raw);
    assert.throws(() => prepareBitcoinTransaction(base64.encode(RawPSBTV0.encode(raw)), publicKeyHex, 'testnet'));
  }
  const wrapped = RawPSBTV0.decode(bitcoinTemplateFixture(['sh-wsh-ms']).bytes);
  wrapped.inputs[0]!.redeemScript![2] = wrapped.inputs[0]!.redeemScript![2]! ^ 1;
  assert.throws(() => prepareBitcoinTransaction(base64.encode(RawPSBTV0.encode(wrapped)), publicKeyHex, 'testnet'));
});

test('Bitcoin template policy rejects duplicate keys, unsupported scripts and nonstandard witness public keys', () => {
  const key = secp256k1.getPublicKey(bitcoinSecret), other = secp256k1.getPublicKey(cosignerSecret);
  const cases: P2Ret[] = [p2wsh(p2ms(2, [key, key], true)), p2wsh(p2ms(1, [bitcoinPublic, other])),
    p2sh(p2ms(2, [key, bitcoinPublic], true)),
    p2sh(p2wpkh(key))];
  for (const [index, payment] of cases.entries()) {
    const previous = new Transaction(); previous.addInput({ txid: new Uint8Array(32).fill(9), index: 0 });
    previous.addOutput({ script: payment.script, amount: 100000n });
    const tx = new Transaction();
    tx.addInput({ txid: previous.id, index: 0, nonWitnessUtxo: previous.toBytes(false, false),
      ...(payment.redeemScript ? { redeemScript: payment.redeemScript } : {}),
      ...(payment.witnessScript ? { witnessScript: payment.witnessScript } : {}) });
    tx.addOutput({ script: p2wpkh(key).script, amount: 99000n });
    const raw = RawPSBTV0.decode(tx.toPSBT(0));
    if (index === 3) raw.inputs[0]!.witnessScript = Uint8Array.of(0x51);
    assert.throws(() => prepareBitcoinTransaction(base64.encode(RawPSBTV0.encode(raw)), publicKeyHex, 'testnet'));
  }
});

test('Bitcoin rejects oversized P2SH redeem scripts and noncanonical multisig pushes even with valid commitments', () => {
  const keys = Array.from({ length: 16 }, (_, index) => secp256k1.getPublicKey(new Uint8Array(32).fill(index + 1)));
  const large = p2ms(16, keys).script;
  const canonical = p2ms(1, [keys[0]!]).script;
  // Change the pubkey push from direct 33 bytes to PUSHDATA1 33 bytes.
  const noncanonical = Uint8Array.from([canonical[0]!, 0x4c, ...canonical.slice(1)]);
  for (const redeemScript of [large, noncanonical]) {
    const outputScript = Uint8Array.from([0xa9, 0x14, ...crypto.hash160(redeemScript), 0x87]);
    const previous = new ReferenceTransaction();
    previous.addInput(new Uint8Array(32).fill(8), 0); previous.addOutput(outputScript, 100000n);
    const reference = new Psbt({ network: networks.testnet });
    reference.addInput({ hash: previous.getId(), index: 0, nonWitnessUtxo: previous.toBuffer(), redeemScript });
    reference.addOutput({ script: payments.p2wpkh({ pubkey: keys[0]!, network: networks.testnet }).output!, value: 99000n });
    assert.throws(() => prepareBitcoinTransaction(base64.encode(reference.toBuffer()), publicKeyHex, 'testnet'), /520|规范/);
  }
});

test('Bitcoin account addresses include independently checked compressed and uncompressed P2PKH', () => {
  const device = relayDevice('evm');
  for (const network of ['mainnet', 'testnet']) {
    const addresses = accountAddresses('bitcoin', device.account.slot, network);
    assert.equal(addresses.length, 4);
    const referenceNetwork = network === 'mainnet' ? networks.bitcoin : networks.testnet;
    assert.equal(addresses[2]!.address, payments.p2pkh({ pubkey: secp256k1.getPublicKey(bitcoinSecret), network: referenceNetwork }).address);
    assert.equal(addresses[3]!.address, payments.p2pkh({ pubkey: bitcoinPublic, network: referenceNetwork }).address);
  }
});

for (const wrapped of [false, true]) test(`Bitcoin ${wrapped ? '15-of-15 P2SH' : '16-of-16 P2WSH'} handles script-size and CompactSize boundaries`, () => {
  const count = wrapped ? 15 : 16;
  const secrets = [bitcoinSecret, ...Array.from({ length: count - 1 }, (_, index) => new Uint8Array(32).fill(index + 3))];
  const keys = secrets.map((secret) => secp256k1.getPublicKey(secret));
  const multisig = payments.p2ms({ m: count, pubkeys: keys, network: networks.testnet });
  const payment = wrapped ? payments.p2sh({ redeem: multisig, network: networks.testnet })
    : payments.p2wsh({ redeem: multisig, network: networks.testnet });
  const previous = new ReferenceTransaction();
  previous.addInput(new Uint8Array(32).fill(7), 0);
  previous.addOutput(payment.output!, 1000000n);
  const reference = new Psbt({ network: networks.testnet });
  reference.addInput({ hash: previous.getId(), index: 0, nonWitnessUtxo: previous.toBuffer(),
    ...(wrapped ? { redeemScript: multisig.output! } : { witnessScript: multisig.output! }) });
  reference.addOutput({ script: payments.p2wpkh({ pubkey: keys[0]!, network: networks.testnet }).output!, value: 999000n });
  secrets.slice(1).forEach((secret, index) => reference.signInput(0, { publicKey: keys[index + 1]!,
    sign: (digest) => secp256k1.sign(digest, secret, { prehash: false }) }));
  const review = prepareBitcoinTransaction(base64.encode(reference.toBuffer()), publicKeyHex, 'testnet');
  assert.equal(review.jobs.length, 1);
  assert.equal(new Map(review.rows).get('输入 0 / 多签门槛'), `${count} / ${count}`);
  const signed = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
  const result = ReferenceTransaction.fromBuffer(finalizeBitcoinTransaction(review, signed));
  reference.signInput(0, { publicKey: keys[0]!, sign: (digest) => secp256k1.sign(digest, bitcoinSecret, { prehash: false }) });
  assert.equal(reference.validateSignaturesOfAllInputs(validator), true);
  reference.finalizeAllInputs();
  assert.equal(result.toHex(), reference.extractTransaction().toHex());
  assert.ok(result.virtualSize() <= Number(new Map(review.rows).get('签名后 vsize 估计上限')));
});

test('Bitcoin mixed standard templates cross production OpenPGP execution and finalize with existing co-signatures', async () => {
  const device = relayDevice('evm');
  const fixture = bitcoinTemplateFixture(bitcoinTemplates, 2);
  const review = prepareBitcoinTransaction(base64.encode(fixture.bytes), publicKeyHex, 'testnet');
  const pin = new TextEncoder().encode('123456');
  const result = await executeReviewedTransaction(device.access, review, device.account.slot, pin);
  assert.equal(result.authenticationCleared, true);
  assert.ok(pin.every((byte) => byte === 0));
  const signed = base64.decode(result.output);
  const extracted = finalizeBitcoinTransaction(review, signed);
  assert.equal(ReferenceTransaction.fromBuffer(extracted).ins.length, 6);
  assert.equal(device.counts().signatures, 6);
  assert.equal(device.counts().verifications, 6);
  assert.equal(device.counts().cleanup, 12);
});
