import assert from 'node:assert/strict';
import test from 'node:test';
import { base64 } from '@scure/base';
import { executeReviewedTransaction } from '../src/signing/execute';
import type { Review } from '../src/signing/execute';
import { OpenPgpDiagnosticError } from '../src/device/openpgp';
import { prepareEvmTransaction, withEvmRpcContext, assertEvmReview } from '../src/chains/evm/transaction';
import { prepareEvmMessage } from '../src/chains/evm/message';
import { prepareBitcoinTransaction } from '../src/chains/bitcoin/transaction';
import { prepareSolanaTransaction, withSolanaRpcContext, assertSolanaReview } from '../src/chains/solana/transaction';
import { prepareSolanaTextMessage } from '../src/chains/solana/message';
import { relayDevice } from './fixtures/relay-device';
import { bitcoinFixture } from './fixtures/bitcoin';
import { solanaFixture } from './fixtures/solana';

const kinds = ['evm-transaction', 'evm-message', 'bitcoin', 'solana-transaction', 'solana-message'] as const;
type Kind = typeof kinds[number];

function fixture(kind: Kind) {
  const device = relayDevice(kind.startsWith('solana') ? 'solana' : 'evm');
  const { publicKeyHex } = device.account;
  let review: Review;
  if (kind === 'evm-transaction') review = prepareEvmTransaction(JSON.stringify({ type: '2', chainId: '1', nonce: '0',
    gasLimit: '21000', to: '0x0000000000000000000000000000000000000001', value: '0', data: '0x',
    maxFeePerGas: '2', maxPriorityFeePerGas: '1', accessList: [] }), publicKeyHex);
  else if (kind === 'evm-message') review = prepareEvmMessage('personal_sign', 'Synthetic deadline test', publicKeyHex);
  else if (kind === 'bitcoin') review = prepareBitcoinTransaction(base64.encode(bitcoinFixture(false, 2)), publicKeyHex, 'testnet');
  else if (kind === 'solana-transaction') review = prepareSolanaTransaction(base64.encode(solanaFixture().bytes), publicKeyHex, 'devnet');
  else review = prepareSolanaTextMessage('Synthetic deadline test', publicKeyHex, 'devnet');
  return { device, review };
}

for (const kind of kinds) test(`${kind} stops expired approvals at discovery, PIN, touch and cleanup boundaries`, async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const phases = ['discovery', 'pin', 'signature', 'cleanup', ...(kind === 'bitcoin' ? ['last-signature', 'last-cleanup'] : [])];
  for (const phase of phases) {
    const { device, review } = fixture(kind), sign = device.access.sign.bind(device.access);
    const jobs = kind === 'bitcoin' ? 2 : 1;
    let advanced = false;
    device.access.sign = (operation) => sign((transport, signal) => operation({ exchange: async (command) => {
      const result = await transport.exchange(command);
      const counts = device.counts();
      const signature = command[1] === 0x88 || command[1] === 0x2a;
      const cleanup = command[1] === 0x20 && command[2] === 0xff;
      if (!advanced && ((phase === 'discovery' && command[1] === 0xa4)
        || (phase === 'pin' && command[1] === 0x20 && command[2] === 0)
        || (phase === 'signature' && signature)
        || (phase === 'last-signature' && signature && counts.signatures === jobs)
        || (phase === 'cleanup' && cleanup)
        || (phase === 'last-cleanup' && cleanup && counts.cleanup === jobs * 2))) {
        advanced = true; context.mock.timers.tick(300000);
      }
      return result;
    } }, signal));
    const pin = new TextEncoder().encode('123456');
    await assert.rejects(executeReviewedTransaction(device.access, review, device.account.slot, pin), (error: unknown) => {
      assert.ok(error instanceof OpenPgpDiagnosticError, phase);
      assert.match(error.message, /过期/, phase);
      assert.equal(error.authenticationCleared, phase !== 'discovery', phase);
      return true;
    });
    assert.ok(advanced, phase); assert.ok(pin.every((byte) => byte === 0), phase);
    const expectedSignatures = phase === 'discovery' || phase === 'pin' ? 0 : phase.startsWith('last-') ? jobs : 1;
    assert.equal(device.counts().signatures, expectedSignatures, phase);
    assert.equal(device.counts().verifications, phase === 'discovery' ? 0 : phase.startsWith('last-') ? jobs : 1, phase);
    assert.equal(device.counts().cleanup, phase === 'discovery' ? 0 : phase.startsWith('last-') ? jobs * 2 : 2, phase);
  }
});

for (const kind of kinds) test(`${kind} retains approvals that are still live after a slow discovery`, async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { device, review } = fixture(kind), sign = device.access.sign.bind(device.access);
  let advanced = false;
  device.access.sign = (operation) => sign((transport, signal) => operation({ exchange: async (command) => {
    const result = await transport.exchange(command);
    if (!advanced && command[1] === 0xa4) { advanced = true; context.mock.timers.tick(299999); }
    return result;
  } }, signal));
  const pin = new TextEncoder().encode('123456');
  const result = await executeReviewedTransaction(device.access, review, device.account.slot, pin);
  assert.ok(result.output.length > 0 && result.authenticationCleared);
  assert.ok(pin.every((byte) => byte === 0));
  assert.equal(device.counts().signatures, kind === 'bitcoin' ? 2 : 1);
});

for (const kind of ['evm-transaction', 'solana-transaction'] as const) test(`${kind} enforces an earlier RPC deadline before PIN or signing APDUs`, async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const phase of ['discovery', 'pin']) {
    const { device, review: original } = fixture(kind), sign = device.access.sign.bind(device.access);
    assert.ok(!('kind' in original) && (original.chain === 'evm' || original.chain === 'solana'));
    const expiresAt = Date.now() + 1000;
    const review = original.chain === 'evm'
      ? withEvmRpcContext(original, { unsignedHex: original.unsignedHex, chainId: original.chainId, expiresAt, accepted: true, rows: [] })
      : withSolanaRpcContext(original, { transactionHex: original.transactionHex, network: original.network, expiresAt, accepted: true, rows: [] });
    let advanced = false;
    device.access.sign = (operation) => sign((transport, signal) => operation({ exchange: async (command) => {
      const result = await transport.exchange(command);
      if (!advanced && ((phase === 'discovery' && command[1] === 0xa4) || (phase === 'pin' && command[1] === 0x20 && command[2] === 0))) {
        advanced = true; context.mock.timers.tick(1000);
      }
      return result;
    } }, signal));
    const pin = new TextEncoder().encode('123456');
    await assert.rejects(executeReviewedTransaction(device.access, review, device.account.slot, pin), /上下文已过期/);
    assert.ok(advanced && pin.every((byte) => byte === 0));
    assert.equal(device.counts().signatures, 0);
    assert.equal(device.counts().verifications, phase === 'discovery' ? 0 : 1);
    assert.equal(device.counts().cleanup, phase === 'discovery' ? 0 : 2);
  }
});

test('EVM RPC wrappers preserve the earliest context deadline and cannot revive expired reviews', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const original = fixture('evm-transaction').review;
  assert.ok(original.chain === 'evm' && !('kind' in original));
  const fields = { unsignedHex: original.unsignedHex, chainId: original.chainId, accepted: true, rows: [] };
  const reviewed = withEvmRpcContext(original, { ...fields, expiresAt: Date.now() + 1000 });
  context.mock.timers.tick(500);
  const extended = withEvmRpcContext(reviewed, { ...fields, expiresAt: Date.now() + 120000 });
  assertEvmReview(extended);
  context.mock.timers.tick(500);
  assert.throws(() => assertEvmReview(extended), /过期/);
  assert.throws(() => withEvmRpcContext(reviewed, { ...fields, expiresAt: Date.now() + 120000 }), /过期/);
});

test('Solana RPC wrappers preserve the earliest context deadline and cannot revive expired reviews', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const original = fixture('solana-transaction').review;
  assert.ok(original.chain === 'solana' && !('kind' in original));
  const fields = { transactionHex: original.transactionHex, network: original.network, accepted: true, rows: [] };
  const reviewed = withSolanaRpcContext(original, { ...fields, expiresAt: Date.now() + 1000 });
  context.mock.timers.tick(500);
  const extended = withSolanaRpcContext(reviewed, { ...fields, expiresAt: Date.now() + 120000 });
  assertSolanaReview(extended);
  context.mock.timers.tick(500);
  assert.throws(() => assertSolanaReview(extended), /过期/);
  assert.throws(() => withSolanaRpcContext(reviewed, { ...fields, expiresAt: Date.now() + 120000 }), /过期/);
});
