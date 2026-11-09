import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction, addr } from 'micro-eth-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { prepareEvmTransaction, attachEvmTransaction, evmTransactionChainId } from '../src/chains/evm/transaction';
import { evmNetworkLabel } from '../src/chains/evm/networks';
import { approveEvmTransaction, consumeEvmApproval, revokeTransactionApproval } from '../src/signing/approval';
import { strictJson } from '../src/signing/json';

const secret = new Uint8Array(32).fill(1);
const publicKeyHex = bytesToHex(secp256k1.getPublicKey(secret, false));
const slot = { slot: 'AUT', algorithm: 'secp256k1', algorithmHex: '132b8104000a', publicKeyHex, uifHex: '0120' } as const;
function input(type = '2') {
  return { type, chainId: '31337', nonce: '0', gasLimit: '21000',
    to: '0x0000000000000000000000000000000000000001', value: '17', data: '0x',
    ...(type === '2' ? { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', accessList: [] }
      : { gasPrice: '2000000000', ...(type === '1' ? { accessList: [] } : {}) }) };
}
for (const type of ['0', '1', '2']) test(`EVM type ${type} real transaction review, external signature and serialized roundtrip`, () => {
  const review = prepareEvmTransaction(JSON.stringify(input(type)), publicKeyHex, '31337');
  assert.equal(review.signable, true);
  assert.equal(review.sender, addr.fromPublicKey(hexToBytes(publicKeyHex)));
  assert.ok(review.rows.some(([label, value]) => label === '最大网络费（wei）' && value === '42000000000000'));
  const signature = secp256k1.sign(hexToBytes(review.digestHex), secret, { prehash: false });
  const signed = attachEvmTransaction(review, signature);
  const parsed = Transaction.fromHex(signed);
  assert.equal(parsed.verifySignature(), true);
  assert.equal(parsed.raw.value, 17n);
  assert.equal(parsed.sender, review.sender);
  assert.equal(parsed.toHex({ includeSignature: false }), review.unsignedHex);
  const readOnly = prepareEvmTransaction(signed, publicKeyHex, '31337');
  assert.equal(readOnly.signable, false);
  assert.throws(() => approveEvmTransaction(readOnly, slot));
  assert.equal(prepareEvmTransaction(review.unsignedHex, publicKeyHex, '31337').digestHex, review.digestHex);
});

test('JSON rejects duplicate/escaped duplicate fields and imprecise or ambiguous quantities', () => {
  assert.throws(() => strictJson('{"a":1,"\\u0061":2}'), /Duplicate/);
  assert.deepEqual(strictJson('{"a":{"a":1},"text":"brace } and \\\"quote"}'), { a: { a: 1 }, text: 'brace } and "quote' });
  for (const value of [0, -1, '01', '-1', '1.1', '0x00', '0x', '1e9']) {
    assert.throws(() => prepareEvmTransaction(JSON.stringify({ ...input(), value }), publicKeyHex, '31337'));
  }
  for (const override of [{ chainId: '0' }, { chainId: '1' }, { type: '3' }, { gas: '21000' }, { data: '0x1' }, { to: 'invalid' }]) {
    assert.throws(() => prepareEvmTransaction(JSON.stringify({ ...input(), ...override }), publicKeyHex, '31337'));
  }
});

test('EVM rejects type 4 JSON, encoded transactions and authorization fields at the shared parser', () => {
  const encoded = '0x04f840827a69800102830186a09400000000000000000000000000000000000000018080c0dddc827a6994000000000000000000000000000000000000000209800101';
  const transaction = Transaction.fromHex(encoded);
  assert.equal(transaction.type, 'eip7702');
  for (const source of [encoded, transaction.signBy(secret).toHex(),
    JSON.stringify({ ...input(), type: '4' }), JSON.stringify({ ...input(), type: '0x4' }),
    JSON.stringify({ ...input(), authorizationList: [] }),
    JSON.stringify({ chainId: '31337', address: input().to, nonce: '0' })]) {
    assert.throws(() => prepareEvmTransaction(source, publicKeyHex));
    assert.throws(() => evmTransactionChainId(source));
  }
});

test('unknown calldata and contract creation remain visible and cannot be approved', () => {
  for (const override of [{ data: '0xdeadbeef' }, { to: '' }]) {
    const review = prepareEvmTransaction(JSON.stringify({ ...input(), gasLimit: '100000', ...override }), publicKeyHex, '31337');
    assert.equal(review.signable, false);
    assert.throws(() => approveEvmTransaction(review, slot));
  }
});

test('ERC20 transfer/approve preserve raw data, spender and integer amount in the review', () => {
  for (const selector of ['a9059cbb', '095ea7b3']) {
    const data = `0x${selector}${'0'.repeat(63)}1${'f'.repeat(64)}`;
    const review = prepareEvmTransaction(JSON.stringify({ ...input(), value: '0', gasLimit: '100000', data }), publicKeyHex, '31337');
    assert.equal(review.signable, true);
    assert.ok(review.rows.some(([label, value]) => label === '原始 calldata' && value === data));
    if (selector === '095ea7b3') assert.ok(review.rows.some(([, value]) => value === '无限授权'));
  }
});

test('approval captures immutable account, is expiring, revocable and consumed once', (context) => {
  const review = prepareEvmTransaction(JSON.stringify(input()), publicKeyHex, '31337');
  assert.equal(Object.isFrozen(review.rows[0]), true);
  const approved = approveEvmTransaction(review, slot);
  assert.equal(consumeEvmApproval(approved).review, review);
  assert.throws(() => consumeEvmApproval(approved));
  const revoked = approveEvmTransaction(review, slot);
  revokeTransactionApproval(revoked);
  assert.throws(() => consumeEvmApproval(revoked));
  context.mock.timers.enable({ apis: ['Date'] });
  const expired = approveEvmTransaction(review, slot);
  context.mock.timers.tick(300001);
  assert.throws(() => consumeEvmApproval(expired), /过期/);
  assert.throws(() => approveEvmTransaction({ ...review }, slot));
  assert.throws(() => approveEvmTransaction(review, { ...slot, publicKeyHex: '00' }));
});

test('manual EVM review derives chainId from JSON or serialized transactions and resolves common names', () => {
  for (const type of ['0', '1', '2']) {
    for (const chainId of ['1', '0x2105', '42161', '999999999']) {
      const source = JSON.stringify({ ...input(type), chainId });
      const review = prepareEvmTransaction(source, publicKeyHex);
      assert.equal(review.chainId, BigInt(chainId).toString());
      assert.equal(prepareEvmTransaction(review.unsignedHex, publicKeyHex).chainId, review.chainId);
      assert.equal(evmTransactionChainId(source), review.chainId);
      assert.equal(evmTransactionChainId(review.unsignedHex), review.chainId);
      assert.ok(review.rows.some(([label, value]) => label === '网络（来自交易）' && value.includes(`chainId ${review.chainId}`)));
      const signed = attachEvmTransaction(review, secp256k1.sign(hexToBytes(review.digestHex), secret, { prehash: false }));
      assert.equal(Transaction.fromHex(signed).raw.chainId, BigInt(chainId));
    }
  }
  assert.match(evmNetworkLabel('8453'), /Base/);
  assert.match(evmNetworkLabel('999999999'), /未内置名称/);
  for (const chainId of ['0', undefined, 1]) {
    assert.throws(() => prepareEvmTransaction(JSON.stringify({ ...input(), chainId }), publicKeyHex));
  }
});
