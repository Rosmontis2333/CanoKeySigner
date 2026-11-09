import assert from 'node:assert/strict';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { addr, eip191Signer, signTyped, verifyTyped, parseSignature } from 'micro-eth-signer';
import { prepareEvmMessage, assertEvmMessageReview, attachEvmMessageSignature } from '../src/chains/evm/message';
import { reviewTypedData } from '../src/chains/evm/typed-data';
import { etherMail } from './fixtures/evm-message';

const secret = new Uint8Array(32).fill(1);
const publicKey = secp256k1.getPublicKey(secret, false);
const publicKeyHex = bytesToHex(publicKey), address = addr.fromPublicKey(publicKey);
const prepare = (typed: unknown, network = '1') => reviewTypedData(JSON.stringify(typed), network);
function checkReference(typed: unknown): void {
  const json = JSON.stringify(typed), review = reviewTypedData(json, '1');
  const reference = signTyped(JSON.parse(json), secret);
  const parsed = parseSignature(reference);
  const compact = new secp256k1.Signature(parsed.r, parsed.s).toBytes('compact');
  assert.ok(secp256k1.verify(compact, hexToBytes(review.digestHex), publicKey, { prehash: false }));
  const message = prepareEvmMessage('eth_signTypedData_v4', json, publicKeyHex, '1');
  const signed = attachEvmMessageSignature(message, secp256k1.sign(hexToBytes(review.digestHex), secret, { prehash: false }));
  assert.ok(verifyTyped(signed, JSON.parse(json), address));
}

test('personal_sign hashes the exact EIP-191 bytes and produces interoperable low-S r/s/v', () => {
  const text = 'example.org wants you to sign in\n账户验证\t123\r\n';
  const bytes = new TextEncoder().encode(text), hex = '0x' + bytesToHex(bytes);
  const review = prepareEvmMessage('personal_sign', text, publicKeyHex, '1');
  const wire = prepareEvmMessage('personal_sign', hex, publicKeyHex, '1', 'hex');
  const expected = keccak_256(new TextEncoder().encode('\x19Ethereum Signed Message:\n' + bytes.length + text));
  assert.equal(review.digestHex, bytesToHex(expected));
  assert.equal(wire.digestHex, review.digestHex);
  assert.equal(review.content, hex.slice(2));
  assert.ok(review.rows.some(([label, value]) => label.includes('正文') && value === JSON.stringify(text)));
  assert.ok(review.rows.some(([, value]) => value.includes('其他网络复用')));
  const raw = secp256k1.Signature.fromBytes(secp256k1.sign(expected, secret, { prehash: false }), 'compact');
  const highS = new secp256k1.Signature(raw.r, secp256k1.Point.Fn.ORDER - raw.s).toBytes('compact');
  const result = attachEvmMessageSignature(review, highS);
  assert.match(result, /^0x[0-9a-f]{128}1[bc]$/);
  assert.ok(eip191Signer.verify(result, bytes, address));
  assert.ok(parseSignature(result).s <= secp256k1.Point.Fn.ORDER / 2n);
  assert.throws(() => attachEvmMessageSignature(review, secp256k1.sign(new Uint8Array(32), secret, { prehash: false })));
  assert.throws(() => attachEvmMessageSignature(review, secp256k1.sign(expected, new Uint8Array(32).fill(2), { prehash: false })));
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.rows) && review.rows.every(Object.isFrozen));
  assert.throws(() => assertEvmMessageReview({ ...review }));
});

test('personal_sign rejects binary, malformed or hidden content, unsafe network and oversized messages', () => {
  for (const text of ['', 'hello\u0000', 'pay\u202exyz', 'hello\ufeff', 'a\u200bb', '\ud800', 'a'.repeat(16385)]) {
    assert.throws(() => prepareEvmMessage('personal_sign', text, publicKeyHex, '1'));
  }
  for (const hex of ['hello', '0x0', '0xff', '0xc0af', '0xefbbbf6869']) {
    assert.throws(() => prepareEvmMessage('personal_sign', hex, publicKeyHex, '1', 'hex'));
  }
  for (const network of ['0', '01', '-1', (1n << 256n).toString()]) {
    assert.throws(() => prepareEvmMessage('personal_sign', 'hi', publicKeyHex, network));
  }
  assert.equal(prepareEvmMessage('personal_sign', 'a'.repeat(16384), publicKeyHex, '1').content.length, 32768);
});

test('EIP-712 matches the official Ether Mail digest and public reference signer', () => {
  const review = prepare(etherMail);
  assert.equal(review.domainHashHex, 'f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f');
  assert.equal(review.messageHashHex, 'c52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e');
  assert.equal(review.digestHex, 'be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  checkReference(etherMail);
  const { EIP712Domain: omitted, ...types } = etherMail.types;
  assert.ok(omitted.length);
  assert.equal(prepare({ ...etherMail, types }).digestHex, review.digestHex);
});

test('EIP-712 integer widths, byte padding, arrays, structs and dependency sorting match the public library', () => {
  for (let width = 8; width <= 256; width += 8) {
    for (const value of ['0', ((1n << BigInt(width)) - 1n).toString()]) {
      checkReference({ types: { Value: [{ name: 'number', type: `uint${width}` }] }, primaryType: 'Value', domain: { chainId: '1' }, message: { number: value } });
    }
    for (const value of [(-(1n << BigInt(width - 1))).toString(), ((1n << BigInt(width - 1)) - 1n).toString()]) {
      checkReference({ types: { Value: [{ name: 'number', type: `int${width}` }] }, primaryType: 'Value', domain: { chainId: '1' }, message: { number: value } });
    }
  }
  for (let size = 1; size <= 32; size++) {
    checkReference({ types: { Value: [{ name: 'data', type: `bytes${size}` }] }, primaryType: 'Value', domain: { chainId: '1' }, message: { data: '0x' + 'ab'.repeat(size) } });
  }
  checkReference({ types: {
    Root: [{ name: 'leaves', type: 'Leaf[2][]' }, { name: 'flags', type: 'bool[]' }, { name: 'children', type: 'Root[]' }],
    Leaf: [{ name: 'text', type: 'string' }, { name: 'bytes', type: 'bytes' }, { name: 'n', type: 'int8' }],
  }, primaryType: 'Root', domain: { chainId: '1', salt: '0x' + 'ab'.repeat(32) },
  message: { leaves: [[{ text: '你好', bytes: '0x', n: '-1' }, { text: '🌟', bytes: '0x0001', n: '127' }]], flags: [true, false], children: [] } });
  checkReference({ types: { $Value: [{ name: '$number', type: 'uint8' }] }, primaryType: '$Value', domain: { chainId: '1' }, message: { $number: '1' } });
});

test('EIP-712 refuses duplicate fields, mismatched domain, undefined types and unreviewable structures', () => {
  const value = (type: string, number: unknown) => ({ types: { Value: [{ name: 'number', type }] }, primaryType: 'Value', domain: { chainId: '1' }, message: { number } });
  for (const [type, number] of [
    ['uint8', '256'], ['uint8', '-1'], ['int8', '-129'], ['int8', '128'], ['bool', 'true'], ['address', '0x1234'],
    ['bytes2', '0x00'], ['bytes', '0x0'], ['uint256', 9007199254740992], ['uint256', '01'], ['string', '\ud800'],
    ['uint', '1'], ['int', '1'], ['uint7', '1'], ['uint0256', '1'], ['bytes33', '0x'], ['bytes01', '0x00'],
    ['Missing', {}], ['uint8[2]', ['1']], ['uint8[0]', []], ['uint8[257]', []], ['string[]', Array(257).fill('a')],
  ] as const) assert.throws(() => prepare(value(type, number)), `${type} ${String(number)}`);
  for (const typed of [
    { ...etherMail, domain: { ...etherMail.domain, chainId: '2' } },
    { ...etherMail, domain: { name: 'No chain' } },
    { ...etherMail, primaryType: 'EIP712Domain' },
    { ...etherMail, primaryType: 'Missing' },
    { ...etherMail, message: { ...etherMail.message, hidden: true } },
    { ...etherMail, message: { from: etherMail.message.from, to: etherMail.message.to } },
    { ...etherMail, message: { ...etherMail.message, from: null } },
    { ...value('uint256', '1'), extra: true },
    { ...value('uint256', '1'), types: { Value: [{ name: 'number', type: 'uint256' }, { name: 'number', type: 'uint256' }] } },
    { ...value('uint256', '1'), types: { Value: [{ name: '__proto__', type: 'string' }] } },
  ]) assert.throws(() => prepare(typed));
  const source = JSON.stringify(etherMail).replace('"contents":"Hello, Bob!"', '"contents":"Hi","contents":"Hello, Bob!"');
  assert.throws(() => reviewTypedData(source, '1'), /Duplicate/);
  const malformedDomain = { ...etherMail, types: { ...etherMail.types, EIP712Domain: [{ name: 'chainId', type: 'uint8' }] } };
  assert.throws(() => prepare(malformedDomain));
  const manyFields = Array.from({ length: 257 }, (_, i) => ({ name: `field${i}`, type: 'uint8' }));
  assert.throws(() => prepare({ ...value('uint8', '1'), types: { Value: manyFields } }), /256/);
  for (const number of ['1.00000000000000000001', '1e0', '-0', '9007199254740993']) {
    const json = JSON.stringify(value('uint256', 'replace')).replace('"replace"', number);
    assert.throws(() => reviewTypedData(json, '1'), /安全整数/);
  }
});

test('EIP-712 bounds recursion and total work and escapes invisible characters in complete review', () => {
  let message: { children: unknown[] } = { children: [] };
  for (let i = 0; i < 25; i++) message = { children: [message] };
  assert.throws(() => prepare({ types: { Node: [{ name: 'children', type: 'Node[]' }] }, primaryType: 'Node', domain: { chainId: '1' }, message }), /资源/);
  assert.throws(() => prepare({ types: { Rows: [{ name: 'values', type: 'uint8[][]' }] }, primaryType: 'Rows', domain: { chainId: '1' }, message: { values: Array.from({ length: 9 }, () => Array(256).fill('1')) } }), /资源/);
  const types = Object.fromEntries(Array.from({ length: 63 }, (_, i) => [
    'Type' + String(i).padStart(2, '0') + 'a'.repeat(55),
    Array.from({ length: 4 }, (_, field) => ({ name: `field${field}` + 'b'.repeat(50),
      type: i === 62 ? 'uint8' : 'Type' + String(i + 1).padStart(2, '0') + 'a'.repeat(55) + '[]' })),
  ]));
  assert.throws(() => prepare({ types, primaryType: Object.keys(types)[0], domain: { chainId: '1' }, message: {} }), /资源/);
  const typed = { ...etherMail, message: { ...etherMail.message, contents: 'hello\u202eworld' } };
  const review = prepareEvmMessage('eth_signTypedData_v4', JSON.stringify(typed), publicKeyHex, '1');
  const display = review.rows.map((row) => row[1]).join('\n');
  assert.ok(display.includes('\\u202e'));
  assert.ok(!display.includes('\u202e'));
  assert.equal(JSON.parse(review.content).message.contents, typed.message.contents);
});

test('manual typed messages derive the network from Domain while personal messages keep their own scope', () => {
  const typed = { ...etherMail, domain: { ...etherMail.domain, chainId: '0x2105' } };
  const review = prepareEvmMessage('eth_signTypedData_v4', JSON.stringify(typed), publicKeyHex);
  assert.equal(review.chainId, '8453');
  assert.ok(review.rows.some(([label, value]) => label === '网络（来自 Domain）' && value.includes('Base')));
  assert.equal(reviewTypedData(JSON.stringify(typed)).chainId, '8453');
  const personal = prepareEvmMessage('personal_sign', 'Synthetic test message', publicKeyHex);
  assert.equal(personal.chainId, '');
  assert.throws(() => prepareEvmMessage('eth_signTypedData_v4', JSON.stringify({ ...typed, domain: { chainId: '0' } }), publicKeyHex));
});
