import assert from 'node:assert/strict';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Transaction } from 'micro-eth-signer';
import * as AbiFunction from 'ox/AbiFunction';
import { reviewEvmCalldata } from '../src/chains/evm/calldata';
import { prepareEvmTransaction, attachEvmTransaction } from '../src/chains/evm/transaction';
import { approveEvmTransaction } from '../src/signing/approval';
import { executeReviewedTransaction } from '../src/signing/execute';
import { relayDevice } from './fixtures/relay-device';
import { tokenCallVectors, encodeTokenCall, tokenFrom, tokenTo, tokenOperator, tokenContract, tokenTransactionInput } from './fixtures/evm-calldata';

const secret = new Uint8Array(32).fill(1);
const publicKeyHex = bytesToHex(secp256k1.getPublicKey(secret, false));
const slot = { slot: 'AUT', algorithm: 'secp256k1', publicKeyHex, algorithmHex: '132b8104000a', uifHex: '0120' } as const;
const reviewCall = (data: string, value = '0') => prepareEvmTransaction(JSON.stringify({ ...tokenTransactionInput(data), value }), publicKeyHex);

for (const vector of tokenCallVectors) test(`EVM ${vector.signature} reviews and signs the exact independent ABI vector`, () => {
  const data = encodeTokenCall(vector.signature, vector.args);
  assert.equal(data.slice(2, 10), vector.selector);
  const review = reviewCall(data);
  assert.equal(review.signable, true);
  const rows = new Map(review.rows);
  assert.equal(rows.get('函数签名（ABI 匹配）'), vector.signature);
  assert.equal(rows.get('原始 calldata'), data);
  assert.equal(rows.get('收款 / 合约地址'), tokenContract);
  const result = attachEvmTransaction(review, secp256k1.sign(hexToBytes(review.digestHex), secret, { prehash: false }));
  const transaction = Transaction.fromHex(result);
  assert.equal(transaction.verifySignature(), true);
  assert.equal(transaction.toHex({ includeSignature: false }), review.unsignedHex);
  assert.equal(`0x${transaction.raw.data.replace(/^0x/, '')}`, data);
  const reference = AbiFunction.decodeData(AbiFunction.from(`function ${vector.signature}`), data);
  assert.deepEqual(reference, vector.args);
  assert.equal(prepareEvmTransaction(review.unsignedHex, publicKeyHex).digestHex, review.digestHex);
  assert.equal(prepareEvmTransaction(result, publicKeyHex).signable, false);
});

test('EVM shared approve and transferFrom selectors show both asset meanings, full integers and allowance scope', () => {
  const maximum = (1n << 256n) - 1n;
  const approve = new Map(reviewCall(encodeTokenCall('approve(address,uint256)', [tokenOperator, maximum])).rows);
  assert.match(approve.get('调用解释')!, /ERC-20.*ERC-721/);
  assert.equal(approve.get('ERC-20 数量（最小单位）'), maximum.toString());
  assert.equal(approve.get('ERC-721 Token ID'), maximum.toString());
  assert.equal(approve.get('ERC-20 授权额度'), '无限授权');
  assert.equal(approve.get('Spender / Approved'), tokenOperator);
  const clear = new Map(reviewCall(encodeTokenCall('approve(address,uint256)', ['0x0000000000000000000000000000000000000000', 0n])).rows);
  assert.match(clear.get('ERC-20 授权效果')!, /设为零/);
  assert.match(clear.get('ERC-721 授权效果')!, /清除/);
  const transfer = new Map(reviewCall(encodeTokenCall('transferFrom(address,address,uint256)', [tokenFrom, tokenTo, maximum])).rows);
  assert.equal(transfer.get('转出账户 from'), tokenFrom);
  assert.equal(transfer.get('接收账户 to'), tokenTo);
  assert.equal(transfer.get('ERC-20 数量（最小单位）'), maximum.toString());
  assert.equal(transfer.get('ERC-721 Token ID'), maximum.toString());
  assert.match(transfer.get('资产标准')!, /需要核对目标合约/);
});

test('EVM operator-wide approvals, revocations, zero transfers and payable ERC721 value have explicit reviews', () => {
  for (const approved of [true, false]) {
    const review = reviewCall(encodeTokenCall('setApprovalForAll(address,bool)', [tokenOperator, approved]));
    const rows = new Map(review.rows);
    assert.equal(rows.get('全部资产授权'), approved ? '授予' : '撤销');
    assert.equal(rows.get('Operator'), tokenOperator);
    assert.match(rows.get('授权范围')!, /当前及未来/);
  }
  for (const signature of ['approve(address,uint256)', 'transferFrom(address,address,uint256)',
    'safeTransferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256,bytes)']) {
    const vector = tokenCallVectors.find((vector) => vector.signature === signature)!;
    const review = reviewCall(encodeTokenCall(signature, vector.args), '29');
    assert.equal(review.signable, true);
    assert.equal(new Map(review.rows).get('随调用发送的原生币（wei）'), '29');
    assert.match(new Map(review.rows).get('原生币处理')!, /ERC-721.*payable/);
  }
  for (const vector of tokenCallVectors.filter((vector) => ['a9059cbb', 'a22cb465', 'f242432a', '2eb2c2d6'].includes(vector.selector))) {
    const review = reviewCall(encodeTokenCall(vector.signature, vector.args), '1');
    assert.equal(review.signable, false);
    assert.throws(() => approveEvmTransaction(review, slot));
  }
  assert.equal(reviewCall(encodeTokenCall('transfer(address,uint256)', [tokenTo, 0n])).signable, true);
});

test('EVM dynamic callbacks and batches keep exact bytes, repeated IDs, item ordering and matching amounts', () => {
  const data = '0x00ff010203';
  const source = encodeTokenCall('safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
    [tokenFrom, tokenTo, [99n, 99n, 0n], [5n, 0n, (1n << 256n) - 1n], data]);
  const review = reviewCall(source), rows = new Map(review.rows);
  assert.equal(review.signable, true);
  assert.equal(rows.get('批量条目数'), '3');
  assert.equal(rows.get('条目 1 · Token ID'), '99');
  assert.equal(rows.get('条目 2 · Token ID'), '99');
  assert.equal(rows.get('条目 3 · Token ID'), '0');
  assert.equal(rows.get('条目 2 · 数量（最小单位）'), '0');
  assert.equal(rows.get('条目 3 · 数量（最小单位）'), ((1n << 256n) - 1n).toString());
  assert.equal(rows.get('接收方回调数据 Hex'), data);
  assert.equal(rows.get('接收方回调数据字节数'), '5');
  const invalid = reviewCall(encodeTokenCall('safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', [tokenFrom, tokenTo, [1n], [], '0x']));
  assert.equal(invalid.signable, false);
  assert.match(new Map(invalid.rows).get('调用解码')!, /长度不一致/);
  const empty = reviewCall(encodeTokenCall('safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', [tokenFrom, tokenTo, [], [], '0x']));
  assert.equal(empty.signable, true);
  assert.equal(new Map(empty.rows).get('批量条目数'), '0');
});

function replaceWord(data: string, word: number, value: bigint): string {
  const start = 10 + word * 64;
  return data.slice(0, start) + value.toString(16).padStart(64, '0') + data.slice(start + 64);
}

test('EVM canonical ABI policy rejects malformed addresses, booleans, truncation, trailing bytes and unknown calls', () => {
  const approval = encodeTokenCall('setApprovalForAll(address,bool)', [tokenOperator, true]);
  const invalid = [replaceWord(approval, 1, 2n), replaceWord(approval, 1, 1n << 255n),
    replaceWord(approval, 0, (1n << 200n) + 1n), approval.slice(0, -2), approval + '00', '0xdeadbeef'];
  for (const data of invalid) {
    const review = reviewCall(data);
    assert.equal(review.signable, false);
    assert.throws(() => approveEvmTransaction(review, slot));
    assert.equal(new Map(review.rows).get('原始 calldata'), data);
  }
  for (const vector of tokenCallVectors) {
    const data = encodeTokenCall(vector.signature, vector.args);
    assert.equal(reviewCall(data.slice(0, -2)).signable, false);
    assert.equal(reviewCall(data + '00'.repeat(32)).signable, false);
  }
});

test('EVM rejects aliased, reordered, unaligned, overflowing and padded dynamic data before allocation', () => {
  const single = encodeTokenCall('safeTransferFrom(address,address,uint256,bytes)', [tokenFrom, tokenTo, 1n, '0x01']);
  const batch = encodeTokenCall('safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', [tokenFrom, tokenTo, [1n, 2n], [3n, 4n], '0x01']);
  const invalid = [replaceWord(single, 3, 0n), replaceWord(single, 3, 129n), replaceWord(single, 3, (1n << 256n) - 1n),
    replaceWord(single, 4, (1n << 256n) - 1n), single.slice(0, -2) + '01',
    replaceWord(batch, 3, 160n), replaceWord(batch, 2, 256n), replaceWord(batch, 5, (1n << 256n) - 1n)];
  for (const data of invalid) {
    const review = reviewCall(data);
    assert.equal(review.signable, false);
    assert.ok(new Map(review.rows).get('调用解码'));
    assert.throws(() => approveEvmTransaction(review, slot));
  }
});

test('EVM ABI resource limits accept 128 items and 4096 callback bytes, refusing each next value', () => {
  for (const length of [0, 1, 31, 32, 33, 4096]) {
    const data = encodeTokenCall('safeTransferFrom(address,address,uint256,bytes)', [tokenFrom, tokenTo, 1n, '0x' + 'ab'.repeat(length)]);
    const review = reviewCall(data);
    assert.equal(review.signable, true);
    assert.equal(new Map(review.rows).get('接收方回调数据字节数'), length.toString());
  }
  const bytes = encodeTokenCall('safeTransferFrom(address,address,uint256,bytes)', [tokenFrom, tokenTo, 1n, '0x' + 'ab'.repeat(4097)]);
  assert.equal(reviewCall(bytes).signable, false);
  for (const count of [128, 129]) {
    const ids = Array.from({ length: count }, (_, index) => BigInt(index));
    const data = encodeTokenCall('safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', [tokenFrom, tokenTo, ids, ids, '0x' + 'ab'.repeat(4096)]);
    assert.equal(reviewCall(data).signable, count === 128);
  }
});

test('EVM calldata rules work on all transaction types and bind decoded values to the approved digest', () => {
  const data = encodeTokenCall('safeTransferFrom(address,address,uint256)', [tokenFrom, tokenTo, 1n]);
  for (const input of [
    { ...tokenTransactionInput(data), type: '0', gasPrice: '2', accessList: undefined, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined },
    { ...tokenTransactionInput(data), type: '1', gasPrice: '2', maxFeePerGas: undefined, maxPriorityFeePerGas: undefined },
    tokenTransactionInput(data),
  ]) {
    const review = prepareEvmTransaction(JSON.stringify(input), publicKeyHex);
    assert.equal(review.signable, true);
    const signature = secp256k1.sign(hexToBytes(review.digestHex), secret, { prehash: false });
    const result = attachEvmTransaction(review, signature);
    assert.equal(Transaction.fromHex(result).verifySignature(), true);
    const changed = prepareEvmTransaction(JSON.stringify({ ...input,
      data: encodeTokenCall('safeTransferFrom(address,address,uint256)', [tokenFrom, tokenTo, 2n]) }), publicKeyHex);
    assert.notEqual(changed.digestHex, review.digestHex);
    assert.throws(() => attachEvmTransaction(changed, signature));
  }
  assert.equal(reviewEvmCalldata('0xa9059cbb', 0n).understood, false);
});

test('EVM token calls cross production OpenPGP review, one-use approval, signature verification and authentication cleanup', async () => {
  const device = relayDevice('evm');
  for (const vector of tokenCallVectors) {
    const data = encodeTokenCall(vector.signature, vector.args);
    const review = reviewCall(data);
    const pin = new TextEncoder().encode('123456');
    const result = await executeReviewedTransaction(device.access, review, device.account.slot, pin);
    const transaction = Transaction.fromHex(result.output);
    assert.equal(transaction.toHex({ includeSignature: false }), review.unsignedHex);
    assert.equal(transaction.verifySignature(), true);
    assert.equal(transaction.sender, device.account.address);
    assert.equal(result.authenticationCleared, true);
    assert.ok(pin.every((byte) => byte === 0));
  }
  assert.equal(device.counts().signatures, tokenCallVectors.length);
  assert.equal(device.counts().cleanup, tokenCallVectors.length * 2);
});
