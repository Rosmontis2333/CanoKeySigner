import assert from 'node:assert/strict';
import test from 'node:test';
import { base58, base64 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { createPublicKey, verify } from 'node:crypto';
import { PublicKey, VersionedTransaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { prepareSolanaTransaction, attachSolanaSignature } from '../src/chains/solana/transaction';
import { decodeSolana, parseMessage, concat } from '../src/chains/solana/codec';
import { associatedTokenAddress } from '../src/chains/solana/instructions';
import { approveSolanaTransaction, consumeSolanaApproval, revokeTransactionApproval } from '../src/signing/approval';
import { solanaFixture, solanaSigner, solanaOther, solanaSeed, solanaDestination, mintKey, tokenInstruction } from './fixtures/solana';
const publicKeyHex = bytesToHex(solanaSigner.publicKey.toBytes());
const slot = { slot: 'SIG', algorithm: 'ed25519', algorithmHex: '162b06010401da470f01', publicKeyHex, uifHex: '0020' } as const;
for (const v0 of [false, true]) for (const multi of [false, true]) test(`Solana ${v0 ? 'v0' : 'legacy'} / ${multi ? 'partial multisig' : 'unsigned'} agrees with official codec and independent Node Ed25519`, () => {
  const fixture = solanaFixture(v0, multi);
  const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet', 'base64', 'transaction', fixture.snapshots);
  assert.equal(review.messageHex, bytesToHex(fixture.message));
  assert.equal(review.signable, true);
  assert.ok(review.rows.some(([, value]) => value === '17'));
  const signature = ed25519.sign(fixture.message, solanaSeed);
  const signed = attachSolanaSignature(review, signature);
  const official = VersionedTransaction.deserialize(signed);
  assert.deepEqual(official.message.serialize(), fixture.message);
  assert.deepEqual(official.signatures[1], fixture.transaction.signatures[1]);
  fixture.transaction.sign([solanaSigner]);
  assert.deepEqual(signed, fixture.transaction.serialize());
  const nodeKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), solanaSigner.publicKey.toBuffer()]) });
  assert.equal(verify(null, fixture.message, nodeKey, signature), true);
  assert.throws(() => attachSolanaSignature(review, ed25519.sign(new Uint8Array(32), solanaSeed)));
  assert.equal(prepareSolanaTransaction(base64.encode(signed), publicKeyHex, 'devnet', 'base64', 'transaction', fixture.snapshots).signable, false);
});

test('message import reconstructs the exact signature slots and explicit encodings roundtrip', () => {
  const fixture = solanaFixture();
  for (const encoding of ['base58', 'base64', 'hex']) {
    const source = encoding === 'base58' ? base58.encode(fixture.message) : encoding === 'base64' ? base64.encode(fixture.message) : bytesToHex(fixture.message);
    assert.deepEqual(Buffer.from(decodeSolana(source, encoding)), Buffer.from(fixture.message));
    const review = prepareSolanaTransaction(source, publicKeyHex, 'devnet', encoding, 'message');
    assert.equal(review.transactionHex, bytesToHex(fixture.bytes));
  }
  assert.throws(() => decodeSolana('AA!', 'base64'));
  assert.throws(() => decodeSolana('abc', 'hex'));
  assert.throws(() => decodeSolana('00', 'guess'));
});

test('v0 ALT resolves writable before readonly and validates raw snapshot context', () => {
  const fixture = solanaFixture(true, false, [tokenInstruction()]);
  const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet', 'base64', 'transaction', fixture.snapshots);
  assert.ok(review.rows.some(([, value]) => value.includes('未经链上验证')));
  assert.ok(review.rows.some(([, value]) => value === '123456789'));
  const parsed = parseMessage(fixture.message);
  assert.deepEqual(parsed.lookups[0]!.writable, [1]);
  assert.deepEqual(parsed.lookups[0]!.readonly, [0]);
  for (const overrides of [{ owner: solanaSigner.publicKey.toBase58() }, { contextSlot: '10' }, { network: 'mainnet-beta' }, { source: '' }, { dataBase64: 'AA==' }]) {
    const snapshots = JSON.parse(fixture.snapshots); Object.assign(snapshots[0], overrides);
    assert.throws(() => prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet', 'base64', 'transaction', JSON.stringify(snapshots)));
  }
  assert.throws(() => prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet'));
});

test('truncation, aliases, invalid header/index, bad existing signatures and unsupported versions reject', () => {
  const fixture = solanaFixture(false, true);
  const badSignature = fixture.bytes.slice(); badSignature[65] = badSignature[65]! ^ 1;
  assert.throws(() => prepareSolanaTransaction(base64.encode(badSignature), publicKeyHex, 'devnet'));
  const badHeader = fixture.message.slice(); badHeader[2] = 255;
  const badProgram = fixture.message.slice(); badProgram[4 + badProgram[3]! * 32 + 32 + 1] = 255;
  const version1 = concat(Uint8Array.of(129), fixture.message);
  const aliasCount = concat(fixture.message.slice(0, 3), Uint8Array.of(fixture.message[3]! | 128, 0), fixture.message.slice(4));
  for (const message of [badHeader, badProgram, version1, aliasCount, fixture.message.slice(0, -1), concat(fixture.message, Uint8Array.of(0))]) {
    assert.throws(() => prepareSolanaTransaction(base64.encode(message), publicKeyHex, 'devnet', 'base64', 'message'));
  }
});

test('unknown instruction is fully visible and cannot authorize any device input', () => {
  const fixture = solanaFixture(false, false, [new TransactionInstruction({ programId: solanaOther.publicKey, keys: [], data: Buffer.from([1, 2]) })]);
  const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet');
  assert.equal(review.signable, false);
  assert.ok(review.rows.some(([, value]) => value === '0102'));
  assert.throws(() => approveSolanaTransaction(review, slot));
});

test('known instruction details and PDA derivation agree with official APIs', () => {
  const expected = PublicKey.findProgramAddressSync([solanaSigner.publicKey.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), mintKey.toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58();
  assert.equal(associatedTokenAddress(solanaSigner.publicKey.toBase58(), mintKey.toBase58()), expected);
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 123n }),
    SystemProgram.transfer({ fromPubkey: solanaSigner.publicKey, toPubkey: solanaDestination, lamports: 10n }),
    new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('hello') })];
  const fixture = solanaFixture(false, false, instructions);
  const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet');
  assert.equal(review.signable, true);
  assert.ok(review.rows.some(([, value]) => value === '123'));
  assert.ok(review.rows.some(([, value]) => value === '"hello"'));
  const duplicate = solanaFixture(false, false, [...instructions, instructions[0]!]);
  assert.throws(() => prepareSolanaTransaction(base64.encode(duplicate.bytes), publicKeyHex, 'devnet'), /重复/);
});

test('Solana approvals expire, revoke, reject forged review and wrong algorithm slots', (context) => {
  const review = prepareSolanaTransaction(base64.encode(solanaFixture().bytes), publicKeyHex, 'devnet');
  const approved = approveSolanaTransaction(review, slot);
  assert.equal(consumeSolanaApproval(approved).review, review);
  assert.throws(() => consumeSolanaApproval(approved));
  const revoked = approveSolanaTransaction(review, slot); revokeTransactionApproval(revoked);
  assert.throws(() => consumeSolanaApproval(revoked));
  assert.throws(() => approveSolanaTransaction({ ...review }, slot));
  assert.throws(() => approveSolanaTransaction(review, { ...slot, algorithm: 'secp256k1' }));
  context.mock.timers.enable({ apis: ['Date'] });
  const expired = approveSolanaTransaction(review, slot); context.mock.timers.tick(300001);
  assert.throws(() => consumeSolanaApproval(expired));
  assert.equal(Object.isFrozen(review.rows[0]), true);
  assert.equal(bytesToHex(hexToBytes(review.messageHex)), review.messageHex);
});

test('SPL authority, revoke, close, mint, burn and ATA instructions expose their exact effects', () => {
  const token = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const key = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isWritable, isSigner });
  const wallet = key(solanaSigner.publicKey, true, true), destination = key(solanaDestination, true), mint = key(mintKey, true);
  const amount = (type: number) => { const data = Buffer.alloc(9); data[0] = type; data.writeBigUInt64LE(31n, 1); return data; };
  const cases = [
    { data: amount(3), keys: [wallet, destination, wallet], text: 'SPL Token 转移' },
    { data: amount(4), keys: [wallet, destination, wallet], text: 'SPL Token delegate 授权' },
    { data: Buffer.from([5]), keys: [wallet, wallet], text: '撤销 SPL Token delegate 授权' },
    { data: amount(7), keys: [mint, destination, wallet], text: '增发 SPL Token' },
    { data: amount(8), keys: [wallet, mint, wallet], text: '销毁 SPL Token' },
    { data: Buffer.from([9]), keys: [wallet, destination, wallet], text: '关闭 Token 账户并转移全部 SOL' },
    { data: Buffer.concat([Buffer.from([6, 2, 1]), solanaDestination.toBuffer()]), keys: [wallet, wallet], text: '修改 SPL Token authority' },
    { data: Buffer.from([17]), keys: [wallet], text: '同步 Wrapped SOL 余额' },
  ];
  for (const scenario of cases) {
    const fixture = solanaFixture(false, false, [new TransactionInstruction({ programId: token, data: scenario.data, keys: scenario.keys })]);
    const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet');
    assert.equal(review.signable, true);
    assert.ok(review.rows.some(([, value]) => value === scenario.text));
  }
  const ata = new PublicKey(associatedTokenAddress(solanaSigner.publicKey.toBase58(), mintKey.toBase58()));
  const instruction = new TransactionInstruction({ programId: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), data: Buffer.from([1]),
    keys: [wallet, key(ata, true), key(solanaSigner.publicKey, false), key(mintKey, false), key(SystemProgram.programId, false), key(token, false)] });
  const fixture = solanaFixture(false, false, [instruction]);
  assert.equal(prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet').signable, true);
  instruction.keys[1]!.pubkey = solanaDestination;
  const wrong = solanaFixture(false, false, [instruction]);
  assert.throws(() => prepareSolanaTransaction(base64.encode(wrong.bytes), publicKeyHex, 'devnet'), /ATA/);
});

test('durable nonce is decoded only as the first instruction with the correct sysvar', () => {
  const nonce = SystemProgram.nonceAdvance({ noncePubkey: solanaDestination, authorizedPubkey: solanaSigner.publicKey });
  const fixture = solanaFixture(false, false, [nonce]);
  const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet');
  assert.equal(review.signable, true);
  assert.ok(review.rows.some(([, value]) => value.includes('durable nonce')));
  const wrongOrder = solanaFixture(false, false, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), nonce]);
  assert.throws(() => prepareSolanaTransaction(base64.encode(wrongOrder.bytes), publicKeyHex, 'devnet'), /第一条/);
});

test('ALT duplicate indices, wrong activation state, authority and duplicate loaded addresses reject', () => {
  const fixture = solanaFixture(true);
  for (const mutate of [
    (data: Buffer) => data.writeBigUInt64LE(3n, 4),
    (data: Buffer) => { data[21] = 2; },
    (data: Buffer) => { data[20] = 255; },
    (data: Buffer) => data.set(solanaSigner.publicKey.toBytes(), 88),
  ]) {
    const snapshots = JSON.parse(fixture.snapshots);
    const data = Buffer.from(snapshots[0].dataBase64, 'base64'); mutate(data); snapshots[0].dataBase64 = data.toString('base64');
    assert.throws(() => prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet', 'base64', 'transaction', JSON.stringify(snapshots)));
  }
  const parsed = parseMessage(fixture.message);
  const lastIndex = fixture.message.length - 2;
  assert.equal(parsed.lookups[0]!.writable.length, 1);
  const badIndex = fixture.message.slice(); badIndex[lastIndex] = 255;
  assert.throws(() => prepareSolanaTransaction(base64.encode(badIndex), publicKeyHex, 'devnet', 'base64', 'message', fixture.snapshots));
  const duplicateIndex = concat(fixture.message.slice(0, -3), Uint8Array.of(2, fixture.message.at(-2)!, fixture.message.at(-2)!, 0));
  assert.throws(() => prepareSolanaTransaction(base64.encode(duplicateIndex), publicKeyHex, 'devnet', 'base64', 'message', fixture.snapshots), /重复/);
});

test('legacy/v0 oversized protocol transactions reject before any device authorization', () => {
  const fixture = solanaFixture(false, false, [new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    keys: [], data: Buffer.alloc(1200, 0x61) })]);
  assert.ok(fixture.bytes.length > 1232);
  assert.throws(() => prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet'), /1232/);
});
