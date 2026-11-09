import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { ApduTransport } from '../src/device/apdu.js';
import {
  discoverOpenPgp,
  OpenPgpDiagnosticError,
  prepareOpenPgpDiagnostic,
  signOpenPgpDiagnostic,
  signOpenPgpEvmMessage,
  type OpenPgpAlgorithm,
  type OpenPgpDiagnosticCase,
} from '../src/device/openpgp.js';
import { prepareEvmMessage, attachEvmMessageSignature } from '../src/chains/evm/message';
import { approveEvmMessage, consumeEvmMessageApproval, revokeEvmMessageApproval } from '../src/signing/approval';
import { etherMail } from './fixtures/evm-message';
import { addr, eip191Signer, verifyTyped } from 'micro-eth-signer';

const secpSecret = new Uint8Array(32).fill(1);
const edSecret = new Uint8Array(32).fill(2);
const keyFor = (algorithm: OpenPgpAlgorithm) => algorithm === 'secp256k1'
  ? secp256k1.getPublicKey(secpSecret, false) : ed25519.getPublicKey(edSecret);
const algorithmFor = (algorithm: OpenPgpAlgorithm) => hexToBytes(algorithm === 'secp256k1'
  ? '132b8104000a' : '162b06010401da470f01');
const pin = () => new TextEncoder().encode('123456');

function tlv(tag: number, value: Uint8Array): Uint8Array {
  const tags = tag > 255 ? [tag >> 8, tag & 255] : [tag];
  return Uint8Array.from([...tags, 0x82, value.length >> 8, value.length & 255, ...value]);
}

function concat(...bytes: Uint8Array[]): Uint8Array {
  return Uint8Array.from(bytes.flatMap((part) => Array.from(part)));
}

function data(command: Uint8Array): Uint8Array {
  if (command.length <= 5) return new Uint8Array();
  const length = command[4] === 0 ? command[5]! * 256 + command[6]! : command[4]!;
  const start = command[4] === 0 ? 7 : 5;
  return command.slice(start, start + length);
}

class FakeOpenPgp implements ApduTransport {
  sigAlgorithm: OpenPgpAlgorithm = 'secp256k1';
  autAlgorithm: OpenPgpAlgorithm = 'ed25519';
  sigPublicKey: Uint8Array | undefined;
  autPublicKey: Uint8Array | undefined;
  missingSig = false;
  sigAttribute: Uint8Array | undefined;
  sigUif = new Uint8Array([1, 0x20]);
  pwStatus = new Uint8Array([0, 64, 64, 64, 3, 3, 3]);
  duplicateSigAttribute = false;
  verifyStatus = 0x9000;
  cleanupStatus = 0x9000;
  badSignature = false;
  failSigning = false;
  onCommand: ((command: Uint8Array) => void | Promise<void>) | undefined;
  readonly commands: Uint8Array[] = [];
  readonly encodedBuffers: Uint8Array[] = [];
  readonly responseBuffers: Uint8Array[] = [];

  async exchange(command: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const captured = command.slice();
    this.commands.push(captured);
    this.encodedBuffers.push(command);
    let response: Uint8Array = new Uint8Array();
    let status = 0x9000;
    const instruction = command[1];
    if (instruction === 0xa4) {
      assert.deepEqual(Array.from(data(command)), [0xd2, 0x76, 0, 1, 0x24, 1]);
    } else if (instruction === 0xca && command[2] === 0) {
      const attributes = concat(
        tlv(0xc1, this.sigAttribute ?? algorithmFor(this.sigAlgorithm)),
        tlv(0xc2, hexToBytes('122b060104019755010501')),
        tlv(0xc3, algorithmFor(this.autAlgorithm)),
        tlv(0xc4, this.pwStatus), tlv(0xd6, this.sigUif), tlv(0xd8, new Uint8Array([2, 0x20])),
        this.duplicateSigAttribute ? tlv(0xc1, algorithmFor(this.sigAlgorithm)) : new Uint8Array(),
      );
      response = tlv(0x6e, tlv(0x73, attributes));
    } else if (instruction === 0xca && command[2] === 1) {
      assert.equal(command[3], 2);
      response = new Uint8Array([5]);
    } else if (instruction === 0x47) {
      assert.equal(command[2], 0x81, 'key generation must never occur');
      const sig = data(command)[0] === 0xb6;
      if (sig && this.missingSig) status = 0x6a88;
      else {
        const key = sig ? this.sigPublicKey ?? keyFor(this.sigAlgorithm)
          : this.autPublicKey ?? keyFor(this.autAlgorithm);
        response = tlv(0x7f49, tlv(0x86, key));
      }
    } else if (instruction === 0x20) {
      if (command[2] === 0xff) {
        assert.equal(command.length, 4);
        status = this.cleanupStatus;
      } else {
        assert.equal(command[2], 0);
        assert.ok(data(command).length >= 6, 'no empty VERIFY after successful PIN');
        status = this.verifyStatus;
      }
    } else if (instruction === 0x2a || instruction === 0x88) {
      if (this.failSigning) throw new Error('Simulated disconnect after sending signature command');
      const algorithm = instruction === 0x2a ? this.sigAlgorithm : this.autAlgorithm;
      response = algorithm === 'secp256k1'
        ? secp256k1.sign(data(command), secpSecret, { prehash: false })
        : ed25519.sign(data(command), edSecret);
      if (this.badSignature) response.fill(0);
    } else {
      throw new Error('Unexpected or forbidden instruction');
    }
    const returned = concat(response, new Uint8Array([status >> 8, status & 255]));
    this.responseBuffers.push(returned);
    await this.onCommand?.(captured);
    return returned;
  }
}

test('OpenPGP discovery reads SIG/AUT keys, attributes, PW status, touch policy and reports DEC only', async () => {
  const transport = new FakeOpenPgp();
  const result = await discoverOpenPgp(transport);
  assert.equal(result.slots[0]!.algorithm, 'secp256k1');
  assert.equal(result.slots[1]!.algorithm, 'ed25519');
  assert.equal(result.slots[0]!.publicKeyHex, bytesToHex(keyFor('secp256k1')));
  assert.equal(result.slots[1]!.publicKeyHex, bytesToHex(keyFor('ed25519')));
  assert.equal(result.passwordStatusHex, '00404040030303');
  assert.equal(result.pw1Retries, 3);
  assert.equal(result.touchCacheSeconds, 5);
  assert.equal(result.decAlgorithmHex, '122b060104019755010501');
  assert.equal(result.slots[0]!.uifHex, '0120');
  assert.ok(transport.commands.every((command) => [0xa4, 0xca, 0x47].includes(command[1]!)));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.slots), true);
  assert.equal(Object.isFrozen(result.slots[0]), true);
  assert.ok(transport.encodedBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
  assert.ok(transport.responseBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
});

for (const slotName of ['SIG', 'AUT'] as const) {
  for (const algorithm of ['secp256k1', 'ed25519'] as const) {
    test(`OpenPGP ${slotName} ${algorithm} signs only the fixed diagnostic and clears both PW1 uses`, async () => {
      const transport = new FakeOpenPgp();
      transport.sigAlgorithm = algorithm;
      transport.autAlgorithm = algorithm;
      const discovery = await discoverOpenPgp(transport);
      const slot = discovery.slots.find((item) => item.slot === slotName)!;
      const prepared = prepareOpenPgpDiagnostic(slot);
      const pinBytes = pin();
      const evidence = await signOpenPgpDiagnostic(transport, prepared, pinBytes);
      assert.ok(pinBytes.every((byte) => byte === 0));
      assert.equal(evidence.verified, true);
      assert.equal(evidence.authenticationCleared, true);
      assert.equal(evidence.messageHex, prepared.messageHex);
      assert.equal(evidence.inputLength, algorithm === 'secp256k1' ? 32 : prepared.messageLength);
      const signature = hexToBytes(evidence.signatureHex);
      const valid = algorithm === 'secp256k1'
        ? secp256k1.verify(signature, hexToBytes(evidence.inputHex), keyFor(algorithm), { prehash: false })
        : ed25519.verify(signature, hexToBytes(evidence.messageHex), keyFor(algorithm), { zip215: false });
      assert.equal(valid, true);
      const verifies = transport.commands.filter((command) => command[1] === 0x20 && command[2] === 0);
      assert.equal(verifies.length, 1);
      assert.equal(verifies[0]![3], slotName === 'SIG' ? 0x81 : 0x82);
      assert.deepEqual(data(verifies[0]!), pin());
      const signing = transport.commands.filter((command) => command[1] === 0x2a || command[1] === 0x88);
      assert.equal(signing.length, 1);
      assert.deepEqual(Array.from(signing[0]!.subarray(0, 4)), slotName === 'SIG'
        ? [0, 0x2a, 0x9e, 0x9a] : [0, 0x88, 0, 0]);
      assert.deepEqual(data(signing[0]!), hexToBytes(evidence.inputHex));
      assert.deepEqual(transport.commands.slice(-2).map((command) => Array.from(command)), [
        [0, 0x20, 0xff, 0x81], [0, 0x20, 0xff, 0x82],
      ]);
      assert.equal(Object.isFrozen(evidence), true);
      assert.ok(!JSON.stringify(evidence).includes('123456'));
      assert.ok(transport.encodedBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
      assert.ok(transport.responseBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
      const count = transport.commands.length;
      await assert.rejects(signOpenPgpDiagnostic(transport, prepared, pin()), /consumed/);
      assert.equal(transport.commands.length, count);
    });
  }
}

test('OpenPGP Ed25519 fixed 255/256/1331 cases send exact original message bytes within capacity', async () => {
  const transport = new FakeOpenPgp();
  const slot = (await discoverOpenPgp(transport)).slots[1]!;
  for (const [caseId, length, commandLength] of [
    ['length-255', 255, 261], ['length-256', 256, 265], ['length-1331', 1331, 1340],
  ] as const) {
    const prepared = prepareOpenPgpDiagnostic(slot, caseId);
    const evidence = await signOpenPgpDiagnostic(transport, prepared, pin());
    assert.equal(evidence.messageLength, length);
    assert.equal(evidence.inputHex, evidence.messageHex);
    const command = transport.commands.filter((item) => item[1] === 0x88).at(-1)!;
    assert.equal(command.length, commandLength);
    assert.deepEqual(data(command), hexToBytes(evidence.messageHex));
  }
  assert.throws(() => prepareOpenPgpDiagnostic(slot, 'length-1332' as OpenPgpDiagnosticCase), /Unsupported/);
  const secpSlot = (await discoverOpenPgp(transport)).slots[0]!;
  assert.throws(() => prepareOpenPgpDiagnostic(secpSlot, 'length-256'), /basic digest/);
});

test('wrong or exhausted PIN is attempted once, never signs, and clears authentication and all PIN buffers', async () => {
  for (const status of [0x6982, 0x6983]) {
    const transport = new FakeOpenPgp();
    const slot = (await discoverOpenPgp(transport)).slots[0]!;
    transport.verifyStatus = status;
    const pinBytes = pin();
    await assert.rejects(signOpenPgpDiagnostic(transport, prepareOpenPgpDiagnostic(slot), pinBytes), (error: unknown) => {
      assert.ok(error instanceof OpenPgpDiagnosticError);
      assert.equal(error.authenticationCleared, true);
      assert.match(error.message, new RegExp(status.toString(16)));
      return true;
    });
    assert.equal(transport.commands.filter((item) => item[1] === 0x20 && item[2] === 0).length, 1);
    assert.equal(transport.commands.filter((item) => item[1] === 0x2a || item[1] === 0x88).length, 0);
    assert.ok(pinBytes.every((byte) => byte === 0));
    assert.ok(transport.encodedBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
  }
});

test('key, algorithm or touch-policy changes invalidate review before VERIFY', async () => {
  for (const mutate of [
    (transport: FakeOpenPgp) => { transport.sigPublicKey = secp256k1.getPublicKey(new Uint8Array(32).fill(3), false); },
    (transport: FakeOpenPgp) => { transport.sigAlgorithm = 'ed25519'; },
    (transport: FakeOpenPgp) => { transport.sigUif = new Uint8Array([2, 0x20]); },
  ]) {
    const transport = new FakeOpenPgp();
    const slot = (await discoverOpenPgp(transport)).slots[0]!;
    const prepared = prepareOpenPgpDiagnostic(slot);
    mutate(transport);
    const pinBytes = pin();
    await assert.rejects(signOpenPgpDiagnostic(transport, prepared, pinBytes), /changed/);
    assert.equal(transport.commands.filter((item) => item[1] === 0x20).length, 0);
    assert.ok(pinBytes.every((byte) => byte === 0));
  }
});

test('unsupported, missing, malformed and blocked slots never reach a PIN attempt', async () => {
  const missing = new FakeOpenPgp();
  missing.missingSig = true;
  const missingSlot = (await discoverOpenPgp(missing)).slots[0]!;
  assert.throws(() => prepareOpenPgpDiagnostic(missingSlot), /supported signing key/);
  const unsupported = new FakeOpenPgp();
  unsupported.sigAttribute = hexToBytes('010800002002');
  const unsupportedSlot = (await discoverOpenPgp(unsupported)).slots[0]!;
  assert.equal(unsupportedSlot.algorithm, 'unsupported');
  assert.throws(() => prepareOpenPgpDiagnostic(unsupportedSlot), /supported signing key/);
  const malformed = new FakeOpenPgp();
  malformed.sigPublicKey = keyFor('ed25519');
  await assert.rejects(discoverOpenPgp(malformed), /encoding/);
  const duplicated = new FakeOpenPgp();
  duplicated.duplicateSigAttribute = true;
  await assert.rejects(discoverOpenPgp(duplicated), /Duplicate/);
  const blocked = new FakeOpenPgp();
  const blockedSlot = (await discoverOpenPgp(blocked)).slots[0]!;
  blocked.pwStatus[4] = 0;
  await assert.rejects(signOpenPgpDiagnostic(blocked, prepareOpenPgpDiagnostic(blockedSlot), pin()), /blocked/);
  assert.equal(blocked.commands.filter((item) => item[1] === 0x20).length, 0);
  const invalidStatus = new FakeOpenPgp();
  invalidStatus.pwStatus = new Uint8Array(6);
  await assert.rejects(discoverOpenPgp(invalidStatus), /PW status/);
});

test('cancelled or late VERIFY/signature responses cannot complete a diagnostic or trigger another command', async () => {
  for (const instruction of [0xa4, 0x20, 0x2a]) {
    const transport = new FakeOpenPgp();
    const slot = (await discoverOpenPgp(transport)).slots[0]!;
    const prepared = prepareOpenPgpDiagnostic(slot);
    const abort = new AbortController();
    transport.onCommand = (command) => {
      if (command[1] === instruction) abort.abort();
    };
    const pinBytes = pin();
    await assert.rejects(signOpenPgpDiagnostic(transport, prepared, pinBytes, abort.signal), /cancelled/);
    assert.equal(transport.commands.at(-1)![1], instruction);
    assert.ok(pinBytes.every((byte) => byte === 0));
    assert.ok(transport.encodedBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
    assert.ok(transport.responseBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
    assert.ok(transport.commands.filter((command) => command[1] === 0x2a).length <= 1);
  }
});

test('cancellation during authentication cleanup invalidates the pending diagnostic result', async () => {
  const transport = new FakeOpenPgp();
  const slot = (await discoverOpenPgp(transport)).slots[0]!;
  const abort = new AbortController();
  transport.onCommand = (command) => {
    if (command[1] === 0x20 && command[2] === 0xff) abort.abort();
  };
  await assert.rejects(signOpenPgpDiagnostic(
    transport, prepareOpenPgpDiagnostic(slot), pin(), abort.signal,
  ), /cancelled/);
  assert.equal(transport.commands.filter((command) => command[1] === 0x2a).length, 1);
  assert.deepEqual(Array.from(transport.commands.at(-1)!), [0, 0x20, 0xff, 0x81]);
});

test('invalid or uncertain signature fails without retry and cleanup failures remain explicit', async () => {
  for (const failure of ['bad-signature', 'disconnect'] as const) {
    const transport = new FakeOpenPgp();
    const slot = (await discoverOpenPgp(transport)).slots[0]!;
    transport.badSignature = failure === 'bad-signature';
    transport.failSigning = failure === 'disconnect';
    await assert.rejects(signOpenPgpDiagnostic(transport, prepareOpenPgpDiagnostic(slot), pin()));
    assert.equal(transport.commands.filter((command) => command[1] === 0x2a).length, 1);
  }
  const transport = new FakeOpenPgp();
  const slot = (await discoverOpenPgp(transport)).slots[0]!;
  transport.cleanupStatus = 0x6985;
  const evidence = await signOpenPgpDiagnostic(transport, prepareOpenPgpDiagnostic(slot), pin());
  assert.equal(evidence.verified, true);
  assert.equal(evidence.authenticationCleared, false);
  assert.deepEqual(transport.commands.slice(-2).map((command) => command[3]), [0x81, 0x82]);
});

test('only genuine prepared objects sign and all invalid PIN buffers are cleared before any I/O', async () => {
  const transport = new FakeOpenPgp();
  const slot = (await discoverOpenPgp(transport)).slots[0]!;
  const prepared = prepareOpenPgpDiagnostic(slot);
  const before = transport.commands.length;
  await assert.rejects(signOpenPgpDiagnostic(transport, { ...prepared }, pin()), /invalid/);
  const tooShort = new Uint8Array(5).fill(0x31);
  await assert.rejects(signOpenPgpDiagnostic(transport, prepared, tooShort), /6 to 64/);
  assert.ok(tooShort.every((byte) => byte === 0));
  assert.equal(transport.commands.length, before);
});

test('concurrent operations cannot interleave APDUs and captured slot objects cannot change approval', async () => {
  const transport = new FakeOpenPgp();
  const mutableSlot = { ...(await discoverOpenPgp(transport)).slots[0]! };
  const prepared = prepareOpenPgpDiagnostic(mutableSlot);
  const approvedKey = prepared.publicKeyHex;
  mutableSlot.publicKeyHex = bytesToHex(keyFor('ed25519'));
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  transport.onCommand = async () => { await pending; };
  const activeDiscovery = discoverOpenPgp(transport);
  const before = transport.commands.length;
  const rejectedPin = pin();
  await assert.rejects(signOpenPgpDiagnostic(transport, prepared, rejectedPin), /active operation/);
  assert.equal(transport.commands.length, before);
  assert.ok(rejectedPin.every((byte) => byte === 0));
  release!();
  await activeDiscovery;
  transport.onCommand = undefined;
  assert.equal(prepared.publicKeyHex, approvedKey);
  const freshSlot = { ...mutableSlot, publicKeyHex: approvedKey };
  const fresh = prepareOpenPgpDiagnostic(freshSlot);
  assert.equal((await signOpenPgpDiagnostic(transport, fresh, pin())).verified, true);
});

test('reviewed EVM transaction uses the production approval through OpenPGP and preserves exact transaction bytes', async () => {
  const { prepareEvmTransaction, attachEvmTransaction } = await import('../src/chains/evm/transaction');
  const { approveEvmTransaction } = await import('../src/signing/approval');
  const { signOpenPgpEvmTransaction } = await import('../src/device/openpgp');
  const { Transaction } = await import('micro-eth-signer');
  const transport = new FakeOpenPgp();
  const discovered = await discoverOpenPgp(transport);
  const key = discovered.slots[0]!;
  const review = prepareEvmTransaction(JSON.stringify({ type: '2', chainId: '31337', nonce: '0', gasLimit: '21000',
    to: '0x0000000000000000000000000000000000000001', value: '0', data: '0x',
    maxFeePerGas: '2', maxPriorityFeePerGas: '1', accessList: [] }), key.publicKeyHex, '31337');
  const approval = approveEvmTransaction(review, key);
  const pinBuffer = pin();
  const result = await signOpenPgpEvmTransaction(transport, approval, pinBuffer);
  assert.ok(pinBuffer.every((byte) => byte === 0));
  assert.equal(result.authenticationCleared, true);
  const signed = Transaction.fromHex(attachEvmTransaction(review, hexToBytes(result.signatureHex)));
  assert.equal(signed.verifySignature(), true);
  assert.equal(signed.toHex({ includeSignature: false }), review.unsignedHex);
  const command = transport.commands.find((command) => command[1] === 0x2a)!;
  assert.equal(bytesToHex(data(command)), review.digestHex);
  const count = transport.commands.length;
  await assert.rejects(signOpenPgpEvmTransaction(transport, approval, pin()));
  assert.equal(transport.commands.length, count);
});

for (const version of [0, 2] as const) test(`production Bitcoin v${version} signs all approved inputs through OpenPGP with one captured PIN`, async () => {
  const { bitcoinFixture, bitcoinV2Fixture, bitcoinPublic } = await import('./fixtures/bitcoin');
  const { prepareBitcoinTransaction } = await import('../src/chains/bitcoin/transaction');
  const { approveBitcoinTransaction } = await import('../src/signing/approval');
  const { signOpenPgpBitcoinTransaction } = await import('../src/device/openpgp');
  const { base64 } = await import('@scure/base');
  const { Transaction } = await import('@scure/btc-signer');
  const transport = new FakeOpenPgp();
  const slots = await discoverOpenPgp(transport);
  const source = version === 0 ? bitcoinFixture(false, 2) : bitcoinV2Fixture(false, 2);
  const review = prepareBitcoinTransaction(base64.encode(source), bytesToHex(bitcoinPublic), 'testnet');
  const approval = approveBitcoinTransaction(review, slots.slots[0]!);
  const pinBuffer = pin();
  transport.onCommand = async (command) => {
    if (command[1] === 0x2a) {
      assert.ok(pinBuffer.every((byte) => byte === 0));
      await assert.rejects(discoverOpenPgp(transport), /active operation/);
    }
  };
  const result = await signOpenPgpBitcoinTransaction(transport, approval, pinBuffer);
  assert.equal(prepareBitcoinTransaction(base64.encode(result.psbt), bytesToHex(bitcoinPublic), 'testnet').psbtVersion, version);
  assert.equal(result.authenticationCleared, true);
  assert.equal(transport.commands.filter((command) => command[1] === 0x2a).length, 2);
  const tx = Transaction.fromPSBT(result.psbt, { unknown: 'ignore', proprietary: 'ignore' });
  tx.finalize(); assert.equal(tx.isFinal, true);
  const before = transport.commands.length;
  await assert.rejects(signOpenPgpBitcoinTransaction(transport, approval, pin()));
  assert.equal(transport.commands.length, before);
  const abort = new AbortController();
  let signaturesSent = 0;
  transport.onCommand = (command) => {
    if (command[1] === 0x2a && ++signaturesSent === 1) abort.abort();
  };
  const cancelledPin = pin();
  await assert.rejects(signOpenPgpBitcoinTransaction(transport,
    approveBitcoinTransaction(review, slots.slots[0]!), cancelledPin, abort.signal), /cancelled/);
  assert.equal(signaturesSent, 1);
  assert.ok(cancelledPin.every((byte) => byte === 0));
});

test('production Solana signs exact raw message through OpenPGP and preserves existing signer slots', async () => {
  const { solanaFixture, solanaSigner } = await import('./fixtures/solana');
  const { prepareSolanaTransaction } = await import('../src/chains/solana/transaction');
  const { approveSolanaTransaction } = await import('../src/signing/approval');
  const { signOpenPgpSolanaTransaction } = await import('../src/device/openpgp');
  const { base64 } = await import('@scure/base');
  const { VersionedTransaction } = await import('@solana/web3.js');
  const transport = new FakeOpenPgp();
  const slots = await discoverOpenPgp(transport);
  const fixture = solanaFixture(true, true);
  const review = prepareSolanaTransaction(base64.encode(fixture.bytes), bytesToHex(solanaSigner.publicKey.toBytes()),
    'devnet', 'base64', 'transaction', fixture.snapshots);
  const approval = approveSolanaTransaction(review, slots.slots[1]!);
  const pinBuffer = pin();
  const result = await signOpenPgpSolanaTransaction(transport, approval, pinBuffer);
  assert.equal(result.authenticationCleared, true);
  assert.ok(pinBuffer.every((byte) => byte === 0));
  const command = transport.commands.find((command) => command[1] === 0x88)!;
  assert.deepEqual(Buffer.from(data(command)), Buffer.from(fixture.message));
  const signed = VersionedTransaction.deserialize(result.transaction);
  assert.deepEqual(signed.signatures[1], fixture.transaction.signatures[1]);
  fixture.transaction.sign([solanaSigner]);
  assert.deepEqual(result.transaction, fixture.transaction.serialize());
  const before = transport.commands.length;
  await assert.rejects(signOpenPgpSolanaTransaction(transport, approval, pin()));
  assert.equal(transport.commands.length, before);
});

for (const name of ['SIG', 'AUT'] as const) {
  for (const method of ['personal_sign', 'eth_signTypedData_v4'] as const) {
    test(`OpenPGP ${name} signs an independently approved ${method} review and clears authentication`, async () => {
      const transport = new FakeOpenPgp();
      transport.autAlgorithm = 'secp256k1';
      const slot = (await discoverOpenPgp(transport)).slots.find((item) => item.slot === name)!;
      const source = method === 'personal_sign' ? 'CanoKeySigner synthetic message test' : JSON.stringify(etherMail);
      const review = prepareEvmMessage(method, source, slot.publicKeyHex, '1');
      const approval = approveEvmMessage(review, slot), pinBytes = pin();
      const evidence = await signOpenPgpEvmMessage(transport, approval, pinBytes);
      const signature = attachEvmMessageSignature(review, hexToBytes(evidence.signatureHex));
      assert.ok(evidence.authenticationCleared);
      assert.ok(pinBytes.every((byte) => byte === 0));
      const expectedAddress = addr.fromPublicKey(keyFor('secp256k1'));
      assert.ok(method === 'personal_sign' ? eip191Signer.verify(signature, source, expectedAddress)
        : verifyTyped(signature, JSON.parse(source), expectedAddress));
      const signing = transport.commands.filter((command) => command[1] === 0x2a || command[1] === 0x88);
      assert.equal(signing.length, 1);
      assert.equal(bytesToHex(data(signing[0]!)), review.digestHex);
      assert.equal(signing[0]![1], name === 'SIG' ? 0x2a : 0x88);
      assert.deepEqual(transport.commands.slice(-2).map((command) => Array.from(command)), [[0, 0x20, 0xff, 0x81], [0, 0x20, 0xff, 0x82]]);
      const retryPin = pin(), before = transport.commands.length;
      await assert.rejects(signOpenPgpEvmMessage(transport, approval, retryPin), /批准/);
      assert.equal(transport.commands.length, before);
      assert.ok(retryPin.every((byte) => byte === 0));
    });
  }
}

test('message approvals reject fabricated, expired, revoked, changed-key and changed-policy requests before VERIFY', async (context) => {
  const transport = new FakeOpenPgp();
  const slot = (await discoverOpenPgp(transport)).slots[0]!;
  const review = prepareEvmMessage('personal_sign', 'Synthetic test message', slot.publicKeyHex, '1');
  assert.throws(() => approveEvmMessage({ ...review }, slot));
  assert.throws(() => approveEvmMessage(review, { ...slot, publicKeyHex: bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(9), false)) }));
  context.mock.timers.enable({ apis: ['Date'] });
  const approval = approveEvmMessage(review, slot);
  context.mock.timers.tick(300001);
  const expiredPin = pin();
  const before = transport.commands.length;
  await assert.rejects(signOpenPgpEvmMessage(transport, approval, expiredPin), /过期/);
  assert.ok(expiredPin.every((byte) => byte === 0));
  assert.equal(transport.commands.length, before);
  assert.throws(() => consumeEvmMessageApproval({ kind: 'evm-message', expiresAt: Date.now() + 1000 }));
  const revoked = approveEvmMessage(review, slot); revokeEvmMessageApproval(revoked);
  assert.throws(() => consumeEvmMessageApproval(revoked));
  const changed = approveEvmMessage(review, slot);
  transport.sigUif = Uint8Array.of(2, 0x20);
  await assert.rejects(signOpenPgpEvmMessage(transport, changed, pin()), /changed/);
  assert.equal(transport.commands.filter((command) => command[1] === 0x20 || command[1] === 0x2a).length, 0);
});
