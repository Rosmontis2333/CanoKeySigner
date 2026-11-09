import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicKey, verify } from 'node:crypto';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { prepareSolanaTransaction, attachSolanaSignature } from '../src/chains/solana/transaction';
import { associatedTokenAddress } from '../src/chains/solana/instructions';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/chains/solana/token';
import { executeReviewedTransaction } from '../src/signing/execute';
import { approveSolanaTransaction } from '../src/signing/approval';
import { relayDevice } from './fixtures/relay-device';
import { solanaFixture, solanaSigner, solanaSeed, solanaDestination, mintKey } from './fixtures/solana';
import { token2022Instruction, token2022Vectors } from './fixtures/token2022';

const publicKeyHex = bytesToHex(solanaSigner.publicKey.toBytes());
const nodeKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'), solanaSigner.publicKey.toBuffer(),
]) });
const vector = (name: string) => token2022Vectors.find((item) => item.name === name)!;
function prepare(name: string) {
  const item = vector(name);
  const fixture = solanaFixture(false, item.multi, [token2022Instruction(item)]);
  return prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet');
}

for (const item of token2022Vectors) {
  test(`Token-2022 official SDK vector ${item.name} preserves exact legacy/v0 bytes and declared effects`, () => {
    for (const v0 of [false, true]) {
      const instruction = token2022Instruction(item);
      const fixture = solanaFixture(v0, item.multi, [instruction]);
      const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet', 'base64', 'transaction', fixture.snapshots);
      assert.equal(review.signable, item.signable);
      assert.equal(review.messageHex, bytesToHex(fixture.message));
      assert.ok(review.rows.some(([, value]) => value === item.operation));
      assert.ok(review.rows.some(([label, value]) => label.endsWith('/ 原始数据') && value === item.dataHex));
      if (!item.signable) {
        assert.throws(() => approveSolanaTransaction(review, relayDevice('solana').account.slot));
        continue;
      }
      const signature = ed25519.sign(fixture.message, solanaSeed);
      assert.ok(verify(null, fixture.message, nodeKey, signature));
      const signed = attachSolanaSignature(review, signature);
      const decoded = VersionedTransaction.deserialize(signed);
      assert.deepEqual(decoded.message.serialize(), fixture.message);
      if (item.multi) assert.deepEqual(decoded.signatures[1], fixture.transaction.signatures[1]);
      fixture.transaction.sign([solanaSigner]);
      assert.deepEqual(signed, fixture.transaction.serialize());
    }
  });
}

test('Token-2022 fee transfers show gross, withheld and net amounts with self-transfer and u64 boundaries', () => {
  const review = prepare('transferWithFee');
  for (const [suffix, expected] of [['转移总额（最小单位）', '123456789'], ['预期预扣手续费（最小单位）', '12345'],
    ['预计新增可用余额（最小单位）', '123444444'], ['decimals（指令声明）', '6']]) {
    assert.ok(review.rows.some(([label, value]) => label.endsWith(suffix!) && value === expected));
  }
  const maximum = prepare('transferWithFeeMax');
  assert.ok(maximum.rows.some(([, value]) => value === '18446744073709551615'));
  assert.ok(maximum.rows.some(([label, value]) => label.endsWith('预计新增可用余额（最小单位）') && value === '0'));
  const self = prepare('transferWithFeeSelf');
  assert.ok(self.rows.some(([, value]) => value.includes('自转移，仅校验')));
  assert.ok(prepare('transferUnchecked').rows.some(([, value]) => value.includes('未声明预期手续费')));
});

test('Token-2022 configuration reviews expose irreversible authorities, fee schedules and protection changes', () => {
  const absent = prepare('initializeFee00');
  assert.ok(absent.rows.some(([, value]) => value.includes('费率配置将不可更改')));
  assert.ok(absent.rows.some(([, value]) => value.includes('手续费将无法')));
  const set = prepare('setFee');
  assert.ok(set.rows.some(([, value]) => value === '10000'));
  assert.ok(set.rows.some(([, value]) => value === '18446744073709551615'));
  assert.ok(set.rows.some(([, value]) => value.includes('epoch')));
  assert.ok(prepare('authority8').rows.some(([, value]) => value.includes('任意 Token')));
  assert.ok(prepare('disableCpiGuard').rows.some(([, value]) => value.includes('取消此账户的 CPI Guard 限制')));
  assert.ok(prepare('disableMemo').rows.some(([, value]) => value.includes('取消此账户对转入前置 Memo')));
  assert.ok(prepare('withdrawAccounts').rows.some(([label]) => label.endsWith('手续费源账户 1')));
  assert.ok(prepare('withdrawAccountsMultisig').rows.some(([label]) => label.endsWith('多签签名者')));
});

test('Token-2022 recognized formats reject every truncation and trailing byte before approval', () => {
  for (const item of token2022Vectors.filter((item) => item.signable && item.program === TOKEN_2022_PROGRAM_ID)) {
    const original = token2022Instruction(item);
    for (let length = 1; length < original.data.length; length++) {
      const instruction = token2022Instruction(item); instruction.data = instruction.data.subarray(0, length);
      const fixture = solanaFixture(false, item.multi, [instruction]);
      assert.throws(() => {
        const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet');
        approveSolanaTransaction(review, relayDevice('solana').account.slot);
      }, item.name);
    }
    const instruction = token2022Instruction(item); instruction.data = Buffer.concat([instruction.data, Buffer.of(0)]);
    const fixture = solanaFixture(false, item.multi, [instruction]);
    assert.throws(() => prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet'), item.name);
  }
});

test('Token-2022 rejects malformed fee options/rates, impossible fees, authority tags and switch values', () => {
  const mutations: [string, (data: Buffer) => void][] = [
    ['initializeFee00', (data) => { data[2] = 2; }],
    ['initializeFee00', (data) => { data[3] = 2; }],
    ['initializeFee11', (data) => { data[35] = 2; }],
    ['setFee', (data) => { data.writeUInt16LE(10001, 2); }],
    ['initializeFee00', (data) => { data.writeUInt16LE(10001, 4); }],
    ['transferWithFee', (data) => { data.writeBigUInt64LE(123456790n, 11); }],
    ['authority0', (data) => { data[1] = 18; }],
    ['authority0', (data) => { data[2] = 2; }],
    ['enableMemo', (data) => { data[1] = 2; }],
    ['enableCpiGuard', (data) => { data[1] = 2; }],
    ['withdrawAccounts', (data) => { data[2] = 255; }],
  ];
  for (const [name, mutate] of mutations) {
    const instruction = token2022Instruction(vector(name)); mutate(instruction.data);
    const fixture = solanaFixture(false, false, [instruction]);
    assert.throws(() => prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet'), name);
  }
});

test('Token-2022 missing privileges and unreviewed Hook accounts cannot authorize hardware signing', () => {
  for (const name of ['transferWithFee', 'setFee', 'enableMemo', 'enableCpiGuard', 'withdrawAccounts']) {
    const instruction = token2022Instruction(vector(name));
    const writable = name === 'withdrawAccounts' ? instruction.keys[1]! : instruction.keys.find((key) => key.isWritable)!;
    writable.isWritable = false;
    const fixture = solanaFixture(false, false, [instruction]);
    assert.throws(() => prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet'), name);
  }
  const instruction = token2022Instruction(vector('transferWithFee'));
  instruction.keys.push({ pubkey: solanaDestination, isSigner: false, isWritable: false });
  const extra = solanaFixture(false, false, [instruction]);
  assert.throws(() => prepareSolanaTransaction(base64.encode(extra.bytes), publicKeyHex, 'devnet'), /authority|签名者/);
  const multisig = token2022Instruction(vector('transferWithFeeMultisig'));
  multisig.keys[5] = { ...multisig.keys[4]! };
  const duplicate = solanaFixture(false, false, [multisig]);
  assert.throws(() => prepareSolanaTransaction(base64.encode(duplicate.bytes), publicKeyHex, 'devnet'), /多签/);
});

test('Token-2022 unknown extension families remain fully visible and unapprovable', () => {
  for (const [type, subtype] of [[27, 0], [28, 0], [29, 0], [33, 0], [35, 0], [36, 0], [37, 0], [39, 0], [43, 0], [44, 0], [46, 0], [26, 6], [255, 0]]) {
    const instruction = token2022Instruction(vector('enableMemo')); instruction.data = Buffer.of(type!, subtype!);
    const fixture = solanaFixture(false, false, [instruction]);
    const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet');
    assert.equal(review.signable, false);
    assert.ok(review.rows.some(([, value]) => value === instruction.data.toString('hex')));
    assert.throws(() => approveSolanaTransaction(review, relayDevice('solana').account.slot));
  }
});

test('Token-2022 ATA PDA binds the chosen Token program and rejects a legacy-program substitution', () => {
  const expected = vector('createAta').accounts[1]!.address;
  assert.equal(associatedTokenAddress(solanaSigner.publicKey.toBase58(), mintKey.toBase58(), TOKEN_2022_PROGRAM_ID), expected);
  assert.notEqual(associatedTokenAddress(solanaSigner.publicKey.toBase58(), mintKey.toBase58()), expected);
  assert.throws(() => associatedTokenAddress(solanaSigner.publicKey.toBase58(), mintKey.toBase58(), solanaDestination.toBase58()));
  const instruction = token2022Instruction(vector('createAta'));
  instruction.keys[5]!.pubkey = new PublicKey(TOKEN_PROGRAM_ID);
  const fixture = solanaFixture(false, false, [instruction]);
  assert.throws(() => prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet'), /ATA/);
});

test('Token-2022 shared OpenPGP executor signs exact original messages, preserves cosignatures and clears PIN', async () => {
  const device = relayDevice('solana');
  for (const name of ['transferWithFeeMultisig', 'setFee', 'withdrawAccountsMultisig', 'disableCpiGuard', 'createAta']) {
    const item = vector(name), fixture = solanaFixture(true, item.multi, [token2022Instruction(item)]);
    const review = prepareSolanaTransaction(base64.encode(fixture.bytes), publicKeyHex, 'devnet', 'base64', 'transaction', fixture.snapshots);
    const pin = new TextEncoder().encode('123456');
    const result = await executeReviewedTransaction(device.access, review, device.account.slot, pin);
    assert.ok(pin.every((byte) => byte === 0)); assert.equal(result.authenticationCleared, true);
    assert.ok(verify(null, fixture.message, nodeKey, VersionedTransaction.deserialize(base64.decode(result.output)).signatures[0]!));
    fixture.transaction.sign([solanaSigner]);
    assert.deepEqual(base64.decode(result.output), fixture.transaction.serialize());
  }
  assert.equal(device.counts().signatures, 5); assert.equal(device.counts().cleanup, 10);
});
