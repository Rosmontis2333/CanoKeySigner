import assert from 'node:assert/strict';
import test from 'node:test';
import { base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js';
import { Transaction, p2tr } from '@scure/btc-signer';
import { prepareBitcoinTransaction, attachBitcoinSignatures, decodePsbt, finalizeBitcoinTransaction } from '../src/chains/bitcoin/transaction';
import { approveBitcoinTransaction, consumeBitcoinApproval, revokeTransactionApproval } from '../src/signing/approval';
import { bitcoinFixture, bitcoinPublic, bitcoinSecret } from './fixtures/bitcoin';
const publicKeyHex = bytesToHex(bitcoinPublic);
const sign = (digest: string) => bytesToHex(secp256k1.sign(hexToBytes(digest), bitcoinSecret, { prehash: false }));
const slot = { slot: 'SIG', algorithm: 'secp256k1', algorithmHex: '132b8104000a', publicKeyHex, uifHex: '0120' } as const;
for (const wrapped of [false, true]) test(`BTC production ${wrapped ? 'wrapped' : 'native'} reviews every input, preserves opaque fields and signs two owned inputs`, () => {
  const original = bitcoinFixture(wrapped, 2);
  const review = prepareBitcoinTransaction(base64.encode(original), publicKeyHex, 'testnet');
  assert.equal(review.jobs.length, 2);
  assert.equal(review.signable, true);
  assert.ok(review.rows.some(([name, value]) => name === '矿工费（sat）' && value === '1000'));
  assert.ok(review.rows.some(([name, value]) => name === '输入 2 / 所有权' && value === '其他公钥'));
  assert.ok(review.rows.some(([name, value]) => name === '输出 0 / 所有权' && value.includes('未证明')));
  const signed = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
  const before = RawPSBTV0.decode(original), after = RawPSBTV0.decode(signed);
  assert.deepEqual(after.global, before.global);
  assert.deepEqual(after.outputs, before.outputs);
  assert.deepEqual(after.inputs[2], before.inputs[2]);
  assert.deepEqual(after.inputs[0]!.unknown, before.inputs[0]!.unknown);
  const tx = Transaction.fromPSBT(signed, { unknown: 'ignore', proprietary: 'ignore' });
  tx.finalize();
  assert.equal(tx.isFinal, true);
  assert.deepEqual(finalizeBitcoinTransaction(review, signed), tx.extract());
  const tampered = RawPSBTV0.decode(signed);
  tampered.global.unsignedTx!.outputs[0]!.amount--;
  assert.throws(() => finalizeBitcoinTransaction(review, RawPSBTV0.encode(tampered)));
  const rate = review.rows.find(([label]) => label === '签名后 vsize 估计上限')![1];
  assert.ok(tx.vsize <= Number(rate));
  assert.equal(prepareBitcoinTransaction(base64.encode(signed), publicKeyHex, 'testnet').signable, false);
  assert.deepEqual(decodePsbt(bytesToHex(signed), 'hex'), signed);
  assert.throws(() => attachBitcoinSignatures(review, []));
  assert.throws(() => attachBitcoinSignatures(review, review.jobs.map(() => '00'.repeat(64))));
});

test('Bitcoin finalize requires signatures for other participating keys', () => {
  const raw = RawPSBTV0.decode(bitcoinFixture());
  delete raw.inputs[1]!.partialSig;
  const review = prepareBitcoinTransaction(base64.encode(RawPSBTV0.encode(raw)), publicKeyHex, 'mainnet');
  const signed = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
  assert.equal(Transaction.fromPSBT(signed, { unknown: 'ignore' }).getInput(0).partialSig!.length, 1);
  assert.throws(() => finalizeBitcoinTransaction(review, signed), /其他输入/);
});

test('ordinary ECDSA inputs may send funds to a fully displayed Taproot output', () => {
  const output = p2tr(secp256k1.getPublicKey(new Uint8Array(32).fill(4)).slice(1));
  const review = prepareBitcoinTransaction(base64.encode(bitcoinFixture(false, 1, output.script)), publicKeyHex, 'mainnet');
  assert.equal(review.signable, true);
  assert.ok(review.rows.some(([name, value]) => name === '输出 0 / 地址' && value.startsWith('bc1p')));
  const result = attachBitcoinSignatures(review, review.jobs.map((job) => sign(job.digestHex)));
  assert.ok(finalizeBitcoinTransaction(review, result).length > 0);
});

test('BTC rejects missing/forged UTXOs, bad existing signatures, script mismatch, duplicate outpoints and unusual sighash', () => {
  const mutations = [
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { delete raw.inputs[0]!.nonWitnessUtxo; },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[0]!.witnessUtxo!.amount++; },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[1]!.partialSig![0]![1].fill(0); },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[0]!.sighashType = 2; },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.inputs[0]!.redeemScript = new Uint8Array([0]); },
    (raw: ReturnType<typeof RawPSBTV0.decode>) => { raw.global.unsignedTx!.inputs[0]!.txid.fill(9); },
  ];
  for (const mutate of mutations) {
    const raw = RawPSBTV0.decode(bitcoinFixture()); mutate(raw);
    assert.throws(() => prepareBitcoinTransaction(base64.encode(RawPSBTV0.encode(raw)), publicKeyHex, 'mainnet'));
  }
  const tx = Transaction.fromPSBT(bitcoinFixture(), { unknown: 'ignore', proprietary: 'ignore' });
  const duplicate = tx.getInput(0);
  tx.addInput(duplicate, true);
  const duplicated = RawPSBTV0.decode(tx.toPSBT(0));
  delete duplicated.inputs[1]!.partialSig;
  assert.throws(() => prepareBitcoinTransaction(base64.encode(RawPSBTV0.encode(duplicated)), publicKeyHex, 'mainnet'), /重复/);
});

test('BTC network binding, strict encoding and expiring single-use approval', (context) => {
  const source = base64.encode(bitcoinFixture());
  const review = prepareBitcoinTransaction(source, publicKeyHex, 'mainnet');
  assert.throws(() => prepareBitcoinTransaction(source, publicKeyHex, 'guess'));
  assert.throws(() => decodePsbt(source, 'guess'));
  assert.throws(() => decodePsbt('abc', 'hex'));
  assert.throws(() => decodePsbt(source + '!', 'base64'));
  assert.equal(Object.isFrozen(review.jobs[0]), true);
  const approval = approveBitcoinTransaction(review, slot);
  assert.equal(consumeBitcoinApproval(approval).review, review);
  assert.throws(() => consumeBitcoinApproval(approval));
  const revoked = approveBitcoinTransaction(review, slot); revokeTransactionApproval(revoked);
  assert.throws(() => consumeBitcoinApproval(revoked));
  context.mock.timers.enable({ apis: ['Date'] });
  const expired = approveBitcoinTransaction(review, slot); context.mock.timers.tick(300001);
  assert.throws(() => consumeBitcoinApproval(expired));
});
