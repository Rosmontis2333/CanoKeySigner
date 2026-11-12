import { relayDevice } from './fixtures/relay-device';
import { prepareEvmMessage } from '../src/chains/evm/message';
import type { DeviceAccess } from '../src/signing/execute';
import { executeReviewedTransaction } from '../src/signing/execute';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { eip191Signer } from 'micro-eth-signer';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { runWithUsbReconnect } from '../src/device/reconnect';
const key = { vendorId: 0x20a0, productId: 0x42d4, serialNumber: 'original' } as USBDevice;
function fixture() {
  let devices: USBDevice[] = [];
  const usb = Object.assign(new EventTarget(), { async getDevices() { return devices; } });
  const abort = new AbortController();
  return { usb, abort, connect(next = [key]) { devices = next; usb.dispatchEvent(new Event('connect')); } };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('offline signing waits and immediately resumes once the original key connects', async () => {
  const f = fixture(); let waiting = 0, commands = 0;
  const result = runWithUsbReconnect({ usb: f.usb, signal: f.abort.signal, serialNumber: 'original', ready: () => true,
    waiting() { waiting++; }, async attempt(selected, _abort, start) { assert.equal(selected, key); start(); commands++; return 'signature'; } });
  await flush(); assert.equal(commands, 0); assert.equal(waiting, 1);
  f.connect(); assert.equal(await result, 'signature'); assert.equal(commands, 1);
  assert.equal(getEventListeners(f.usb, 'connect').length, 0);
  assert.equal(getEventListeners(f.abort.signal, 'abort').length, 0);
});

test('device-open failures retry but a failure after dispatch never replays signing', async () => {
  const f = fixture(); f.connect(); let opens = 0, commands = 0;
  const result = runWithUsbReconnect({ usb: f.usb, signal: f.abort.signal, ready: () => true, waiting() {},
    async attempt(_device, _abort, start) {
      opens++;
      if (opens === 1) throw new Error('temporary USB open failure');
      start(); commands++; throw new Error('signature response lost');
    } });
  await flush(); f.connect();
  await assert.rejects(result, /signature response lost/);
  assert.equal(opens, 2); assert.equal(commands, 1);
});

test('cancelled waiting rejects and a later device connection cannot start commands', async () => {
  const f = fixture(); let commands = 0;
  const result = runWithUsbReconnect({ usb: f.usb, signal: f.abort.signal, ready: () => true, waiting() {},
    async attempt(_device, _abort, start) { start(); commands++; } });
  await flush(); f.abort.abort(); await assert.rejects(result, /取消/); f.connect(); await flush();
  assert.equal(commands, 0); assert.equal(getEventListeners(f.usb, 'connect').length, 0);
});

test('wrong serials are ignored and waiting expires without a signature', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); f.connect([{ ...key, serialNumber: 'other' } as USBDevice]); let commands = 0;
  const result = assert.rejects(runWithUsbReconnect({ usb: f.usb, signal: f.abort.signal, serialNumber: 'original', timeoutMs: 1000,
    ready: () => true, waiting() {}, async attempt(_device, _abort, start) { start(); commands++; } }), /超时/);
  await flush(); context.mock.timers.tick(1001); await result;
  assert.equal(commands, 0); assert.equal(getEventListeners(f.usb, 'connect').length, 0);
});

test('a late open after timeout cannot dispatch signing', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); f.connect(); let release!: () => void, commands = 0;
  const result = assert.rejects(runWithUsbReconnect({ usb: f.usb, signal: f.abort.signal, timeoutMs: 1000, ready: () => true, waiting() {},
    async attempt(_device, abort, start) {
      await new Promise<void>((resolve) => { release = resolve; });
      assert.equal(abort.signal.aborted, true);
      start(); commands++;
    } }), /超时/);
  await flush(); context.mock.timers.tick(1001); await result; release(); await flush();
  assert.equal(commands, 0);
});

test('explicit device selection resolves multiple matching devices and the wait timer stops on dispatch', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); f.connect([key, { ...key } as USBDevice]);
  const result = runWithUsbReconnect({ usb: f.usb, signal: f.abort.signal, preferred: () => key, timeoutMs: 1000, ready: () => true, waiting() {},
    async attempt(selected, abort, start) {
      assert.equal(selected, key); start(); context.mock.timers.tick(2000);
      assert.equal(abort.signal.aborted, false); return 'signature';
    } });
  assert.equal(await result, 'signature');
});


for (const scenario of ['resume', 'cancel', 'wrong-key'] as const) test(`cached review and PIN across USB loss / ${scenario}`, async () => {
  const f = fixture(), hardware = relayDevice('evm');
  const slot = scenario === 'wrong-key' ? { ...hardware.account.slot,
    publicKeyHex: bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(7), false)) } : hardware.account.slot;
  const text = 'Synthetic offline reconnect approval';
  const review = prepareEvmMessage('personal_sign', text, slot.publicKeyHex);
  const pin = new TextEncoder().encode('123456');
  const access: DeviceAccess = {
    ...hardware.access,
    sign(operation) {
      return runWithUsbReconnect({
        usb: f.usb, signal: f.abort.signal, ready: () => true, waiting() {},
        attempt(_device, abort, start) { start(); return hardware.access.sign((transport) => operation(transport, abort.signal)); },
      });
    },
  };
  const result = executeReviewedTransaction(access, review, slot, pin);
  void result.catch(() => undefined);
  await flush(); assert.equal(hardware.counts().tasks, 0);
  if (scenario === 'cancel') {
    f.abort.abort(); await assert.rejects(result, /取消/); f.connect(); await flush();
    assert.equal(hardware.counts().signatures, 0);
  } else {
    f.connect();
    if (scenario === 'wrong-key') {
      await assert.rejects(result, /public key or touch policy changed/);
      assert.equal(hardware.counts().verifications, 0);
      assert.equal(hardware.counts().signatures, 0);
    } else {
      const signed = await result;
      assert.ok(eip191Signer.verify(signed.output, text, hardware.account.address));
      assert.equal(hardware.counts().signatures, 1);
    }
  }
  assert.ok(pin.every((byte) => byte === 0));
});
