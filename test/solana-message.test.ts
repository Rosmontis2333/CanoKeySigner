import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { base58, base64 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { prepareSolanaMessage, prepareSolanaTextMessage, assertSolanaMessageReview, verifySolanaMessageSignature } from '../src/chains/solana/message';
import { approveSolanaMessage, consumeSolanaMessageApproval, revokeSolanaMessageApproval, consumeSolanaApproval } from '../src/signing/approval';
import { signOpenPgpSolanaMessage } from '../src/device/openpgp';
import { executeReviewedTransaction } from '../src/signing/execute';
import { relayDevice } from './fixtures/relay-device';
import { solanaSeed, solanaSigner, solanaOther, solanaFixture } from './fixtures/solana';
import { offchainMessageFixture } from './fixtures/solana-message';

const publicKey = solanaSigner.publicKey.toBytes(), publicKeyHex = bytesToHex(publicKey);
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), solanaSeed]), format: 'der', type: 'pkcs8' });
const nodePublicKey = createPublicKey(privateKey);
const prepare = (bytes: Uint8Array) => prepareSolanaMessage(base64.encode(bytes), publicKeyHex, 'devnet');

test('Solana manual text produces the exact standard v1 bytes and displays readable text, signer and network scope', () => {
  const text = 'example.org\nSign in\tNonce: abc123\r\n用途：测试';
  const review = prepareSolanaTextMessage(text, publicKeyHex, 'devnet');
  assert.equal(review.messageHex, bytesToHex(offchainMessageFixture({ text })));
  assert.equal(review.version, 1);
  assert.equal(review.signable, true);
  assert.deepEqual(review.signers, [solanaSigner.publicKey.toBase58()]);
  const rows = new Map(review.rows);
  assert.equal(rows.get('消息正文（JSON 转义）'), JSON.stringify(text));
  assert.equal(rows.get('完整签名消息 Hex'), review.messageHex);
  assert.equal(rows.get('Required signer 1'), solanaSigner.publicKey.toBase58());
  assert.match(rows.get('网络绑定范围')!, /可跨网络复用/);
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.signers) && Object.isFrozen(review.rows[0]));
  assert.throws(() => assertSolanaMessageReview({ ...review }));
});

for (const version of [0, 1] as const) test(`Solana offchain v${version} signs exact bytes and matches Node/OpenSSL Ed25519`, () => {
  const bytes = offchainMessageFixture({ version });
  for (const [encoding, source] of [['base64', base64.encode(bytes)], ['base58', base58.encode(bytes)], ['hex', bytesToHex(bytes)]]) {
    const review = prepareSolanaMessage(source!, publicKeyHex, 'devnet', encoding!);
    assert.equal(review.messageHex, bytesToHex(bytes));
    const signature = sign(null, bytes, privateKey);
    assert.deepEqual(verifySolanaMessageSignature(review, signature), Uint8Array.from(signature));
    assert.equal(verify(null, hexToBytes(review.messageHex), nodePublicKey, signature), true);
    assert.throws(() => verifySolanaMessageSignature(review, signature.slice(0, 63)));
    assert.throws(() => verifySolanaMessageSignature(review, sign(null, Buffer.from('different'), privateKey)));
    assert.throws(() => verifySolanaMessageSignature(review, ed25519.sign(bytes, new Uint8Array(32).fill(3))));
  }
  if (version === 0) assert.equal(new Map(prepare(bytes).rows).get('Application domain（消息声明）'), base58.encode(new Uint8Array(32).fill(9)));
});

test('Solana message policy rejects raw text, transaction messages and serialized transactions before hardware signing', () => {
  for (const bytes of [new TextEncoder().encode('hello'), solanaFixture().message, solanaFixture().bytes, solanaFixture(true).message,
    solanaFixture(true).bytes, new Uint8Array(32)]) assert.throws(() => prepare(bytes));
  const bytes = offchainMessageFixture();
  const changed = Uint8Array.from(bytes); changed[0] = 0xfe;
  assert.throws(() => prepare(changed), /域分离/);
  const version = Uint8Array.from(bytes); version[16] = 2;
  assert.throws(() => prepare(version), /v0.*v1/);
});

test('Solana offchain policy refuses malformed UTF8, hidden controls and empty content while preserving readable whitespace', () => {
  for (const text of ['', ' ', '\n\t', 'a\u0000b', 'a\u200bb', '\ufeffhello', 'pay\u202exyz', 'a\u2028b', 'a\u2029b', 'a\u007fb']) {
    assert.throws(() => prepare(offchainMessageFixture({ text })));
    assert.throws(() => prepareSolanaTextMessage(text, publicKeyHex, 'devnet'));
  }
  assert.throws(() => prepareSolanaTextMessage('\ud800', publicKeyHex, 'devnet'), /Unicode/);
  const bad = offchainMessageFixture({ text: 'a' }); bad[bad.length - 1] = 255;
  assert.throws(() => prepare(bad));
  assert.equal(prepare(offchainMessageFixture({ text: 'line1\nline2\tend\r\n' })).signable, true);
});

test('Solana offchain v1 enforces sorted unique valid required signers and selected account membership', () => {
  const other = solanaOther.publicKey.toBytes();
  const signers = [publicKey, other].sort(Buffer.compare);
  const review = prepare(offchainMessageFixture({ signers }));
  assert.equal(review.signable, true);
  assert.deepEqual(review.signers, signers.map((key) => base58.encode(key)));
  assert.throws(() => prepare(offchainMessageFixture({ signers: [...signers].reverse() })), /递增/);
  assert.throws(() => prepare(offchainMessageFixture({ signers: [publicKey, publicKey] })), /重复/);
  assert.throws(() => prepare(offchainMessageFixture({ signers: [] })));
  assert.throws(() => prepare(offchainMessageFixture({ signers: [new Uint8Array(32)] })));
  const outsider = prepare(offchainMessageFixture({ signers: [other] }));
  assert.equal(outsider.signable, false);
  assert.throws(() => approveSolanaMessage(outsider, relayDevice('solana').account.slot));
  const count = offchainMessageFixture(); count[17] = 255;
  assert.throws(() => prepare(count), /数量/);
  for (const network of ['', 'mainnet', 'untrusted']) assert.throws(() => prepareSolanaMessage(base64.encode(offchainMessageFixture()), publicKeyHex, network));
});

test('Solana offchain v0 enforces format, declared length, signer list and encoding without dropping suffix bytes', () => {
  assert.equal(prepare(offchainMessageFixture({ version: 0, format: 0, text: 'ASCII statement' })).signable, true);
  for (const text of ['换行', 'hello\nworld']) assert.throws(() => prepare(offchainMessageFixture({ version: 0, format: 0, text })), /ASCII/);
  assert.throws(() => prepare(offchainMessageFixture({ version: 0, format: 3 })), /格式无效/);
  const bytes = offchainMessageFixture({ version: 0 });
  for (const modified of [bytes.slice(0, -1), Uint8Array.from([...bytes, 0]), bytes.slice(0, 84)]) assert.throws(() => prepare(modified));
  const length = Uint8Array.from(bytes); length[83] = 255; length[84] = 255;
  assert.throws(() => prepare(length));
  assert.throws(() => prepare(offchainMessageFixture({ version: 0, signers: [publicKey, publicKey] })), /重复/);
  assert.throws(() => prepareSolanaMessage(base64.encode(bytes).replace(/=+$/, ''), publicKeyHex, 'devnet'));
  assert.throws(() => prepareSolanaMessage(bytesToHex(bytes) + 'f', publicKeyHex, 'devnet', 'hex'));
});

test('Solana offchain message length accounts for the full preamble and exact CanoKey 1331 byte capacity', () => {
  const accepted = prepareSolanaTextMessage('a'.repeat(1281), publicKeyHex, 'devnet');
  assert.equal(accepted.messageHex.length / 2, 1331);
  assert.throws(() => prepareSolanaTextMessage('a'.repeat(1282), publicKeyHex, 'devnet'), /1331/);
  for (const format of [0, 1]) {
    assert.equal(prepare(offchainMessageFixture({ version: 0, format, text: 'a'.repeat(1147) })).messageHex.length / 2, 1232);
    assert.throws(() => prepare(offchainMessageFixture({ version: 0, format, text: 'a'.repeat(1148) })), /1232/);
  }
  assert.equal(prepare(offchainMessageFixture({ version: 0, format: 2, text: 'a'.repeat(1246) })).messageHex.length / 2, 1331);
  assert.throws(() => prepare(offchainMessageFixture({ version: 0, format: 2, text: 'a'.repeat(1247) })), /1331/);
});

test('Solana message approval independently captures a matching Ed25519 slot, expires, revokes and consumes once', (context) => {
  const review = prepare(offchainMessageFixture()), slot = relayDevice('solana').account.slot;
  const approval = approveSolanaMessage(review, slot);
  assert.throws(() => consumeSolanaApproval(approval));
  assert.equal(consumeSolanaMessageApproval(approval).review, review);
  assert.throws(() => consumeSolanaMessageApproval(approval));
  assert.throws(() => approveSolanaMessage({ ...review }, slot));
  assert.throws(() => approveSolanaMessage(review, relayDevice('evm').account.slot));
  const revoked = approveSolanaMessage(review, slot); revokeSolanaMessageApproval(revoked);
  assert.throws(() => consumeSolanaMessageApproval(revoked));
  context.mock.timers.enable({ apis: ['Date'] });
  const expired = approveSolanaMessage(review, slot); context.mock.timers.tick(300001);
  assert.throws(() => consumeSolanaMessageApproval(expired), /过期/);
});

for (const version of [0, 1] as const) test(`Solana offchain v${version} production OpenPGP signs exact bytes, clears authentication and wipes PIN`, async () => {
  const device = relayDevice('solana');
  const bytes = offchainMessageFixture({ version }), review = prepare(bytes);
  const pin = new TextEncoder().encode('123456');
  const result = await executeReviewedTransaction(device.access, review, device.account.slot, pin);
  assert.deepEqual(base64.decode(result.output), Uint8Array.from(sign(null, bytes, privateKey)));
  assert.equal(result.authenticationCleared, true);
  assert.ok(pin.every((byte) => byte === 0));
  assert.deepEqual(device.counts(), { signatures: 1, tasks: 1, verifications: 1, cleanup: 2, blocked: false });
});

test('Solana offchain OpenPGP rejects consumed, expired or cancelled approvals before device signing and wipes PIN', async () => {
  const device = relayDevice('solana'), review = prepare(offchainMessageFixture());
  const approval = approveSolanaMessage(review, device.account.slot);
  consumeSolanaMessageApproval(approval);
  const transport = { exchange: async () => { throw new Error('Unexpected APDU'); } };
  const pin = new TextEncoder().encode('123456');
  await assert.rejects(signOpenPgpSolanaMessage(transport, approval, pin));
  assert.ok(pin.every((byte) => byte === 0));
  const cancelled = approveSolanaMessage(review, device.account.slot);
  const controller = new AbortController(); controller.abort();
  const secondPin = new TextEncoder().encode('123456');
  await assert.rejects(signOpenPgpSolanaMessage(transport, cancelled, secondPin, controller.signal), /cancelled/);
  assert.ok(secondPin.every((byte) => byte === 0));
  assert.throws(() => consumeSolanaMessageApproval(cancelled));
});

test('Solana offchain maximum-size v0/v1 messages cross extended OpenPGP APDUs without prehashing or truncation', async () => {
  const cases = [offchainMessageFixture({ text: 'a'.repeat(1281) }),
    offchainMessageFixture({ version: 0, format: 2, text: 'a'.repeat(1246) })];
  for (const bytes of cases) {
    const device = relayDevice('solana');
    assert.equal(bytes.length, 1331);
    const result = await executeReviewedTransaction(device.access, prepare(bytes), device.account.slot, new TextEncoder().encode('123456'));
    assert.equal(verify(null, bytes, nodePublicKey, base64.decode(result.output)), true);
    assert.deepEqual(base64.decode(result.output), Uint8Array.from(sign(null, bytes, privateKey)));
    assert.equal(result.authenticationCleared, true);
  }
});
