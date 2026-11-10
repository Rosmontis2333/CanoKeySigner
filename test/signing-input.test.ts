import assert from 'node:assert/strict';
import test from 'node:test';
import { base58, base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { detectEvmInput, detectSolanaInput, detectBitcoinInput, detectAutomaticSolanaInput, decodeSigningFile } from '../src/ui/signing-input';
import { prepareEvmTransaction } from '../src/chains/evm/transaction';
import { prepareEvmMessage } from '../src/chains/evm/message';
import { prepareSolanaTextMessage } from '../src/chains/solana/message';
import { etherMail } from './fixtures/evm-message';
import { solanaFixture, solanaSigner } from './fixtures/solana';
import { solanaV1Fixture } from './fixtures/solana-v1';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const evmKey = bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(1), false));

test('automatic EVM recognition routes transactions, typed data and exact readable text to existing reviews', () => {
  const source = JSON.stringify({ type: '2', chainId: '1', nonce: '0', gasLimit: '21000',
    to: '0x0000000000000000000000000000000000000001', value: '1', data: '0x',
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', accessList: [] });
  assert.equal(detectEvmInput(source), 'transaction');
  const review = prepareEvmTransaction(source, evmKey);
  assert.equal(detectEvmInput(review.unsignedHex), 'transaction');
  assert.equal(detectEvmInput(JSON.stringify(etherMail)), 'eth_signTypedData_v4');
  const text = '  Sign in to example.org\nNonce 123\n';
  assert.equal(detectEvmInput(text), 'personal_sign');
  assert.equal(prepareEvmMessage('personal_sign', text, evmKey).content, bytesToHex(new TextEncoder().encode(text)));
});

test('malformed EVM data and unsupported transaction types cannot fall through to readable text', () => {
  for (const source of ['{', '{"types":{', '{"chainId":"1","chainId":"2"}']) assert.throws(() => detectEvmInput(source));
  for (const source of ['0xzz', '0x04', 'deadbeef', '[]', '{"type":"4"}', '{"type":"3"}']) {
    assert.equal(detectEvmInput(source), 'transaction');
    assert.throws(() => prepareEvmTransaction(source, evmKey));
  }
  const brokenTyped = '{"domain":{}}';
  assert.equal(detectEvmInput(brokenTyped), 'eth_signTypedData_v4');
  assert.throws(() => prepareEvmMessage('eth_signTypedData_v4', brokenTyped, evmKey));
});

test('Solana recognizes legacy, v0 and v1 envelopes and messages across supported encodings', () => {
  for (const fixture of [solanaFixture(), solanaFixture(true), solanaV1Fixture()]) {
    for (const [format, bytes] of [['transaction', fixture.bytes], ['message', fixture.message]] as const) {
      for (const [encoding, source] of [['base64', base64.encode(bytes)], ['hex', bytesToHex(bytes)], ['base58', base58.encode(bytes)]]) {
        assert.deepEqual(detectSolanaInput(source!, encoding!), { kind: 'transaction', format });
      }
    }
  }
});

test('Solana recognizes readable text and domain separated offchain bytes', () => {
  const text = 'Sign in to example.org with this account and nonce 123\n请确认用途';
  assert.equal(detectSolanaInput(text, 'base64').kind, 'offchain-text');
  const message = prepareSolanaTextMessage(text, bytesToHex(solanaSigner.publicKey.toBytes()), 'mainnet-beta');
  assert.equal(detectSolanaInput(message.messageHex, 'hex').kind, 'offchain-import');
  assert.equal(detectSolanaInput('Hello', 'base64').kind, 'offchain-text');
});

test('Solana encoded garbage, truncated envelopes and wrong encodings fail recognition', () => {
  const fixture = solanaFixture();
  for (const source of ['0xzz', 'deadbeef', 'AQ==', base64.encode(fixture.bytes.slice(0, 90)),
    base64.encode(fixture.bytes).slice(0, 60) + '\n' + base64.encode(fixture.bytes).slice(60)]) {
    assert.throws(() => detectSolanaInput(source, 'base64'));
  }
  assert.throws(() => detectSolanaInput(base64.encode(fixture.bytes), 'hex'));
  assert.throws(() => detectSolanaInput('', 'base64'));
});


test('automatic encodings and binary/text imports preserve the same signing bytes', () => {
  for (const fixture of [solanaFixture(), solanaFixture(true), solanaV1Fixture()]) {
    for (const bytes of [fixture.bytes, fixture.message]) {
      for (const source of [base64.encode(bytes), base58.encode(bytes), bytesToHex(bytes), '0x' + bytesToHex(bytes)]) {
        assert.equal(detectAutomaticSolanaInput(source).kind, 'transaction');
        const imported = decodeSigningFile(new TextEncoder().encode(source), 'solana');
        assert.equal(detectAutomaticSolanaInput(imported).kind, 'transaction');
      }
      assert.equal(detectAutomaticSolanaInput(decodeSigningFile(bytes, 'solana')).kind, 'transaction');
    }
  }
  const psbt = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0]);
  for (const source of [base64.encode(psbt), bytesToHex(psbt), '0x' + bytesToHex(psbt)]) {
    assert.ok(detectBitcoinInput(source));
    assert.ok(detectBitcoinInput(decodeSigningFile(new TextEncoder().encode(source), 'bitcoin')));
  }
  assert.ok(detectBitcoinInput(decodeSigningFile(psbt, 'bitcoin')));
  const text = 'Sign in to example.org with nonce 123';
  assert.equal(decodeSigningFile(new TextEncoder().encode(text), 'solana'), text);
  assert.throws(() => detectBitcoinInput('hello'));
  assert.throws(() => decodeSigningFile(new Uint8Array([255, 0, 12]), 'solana'));
});
