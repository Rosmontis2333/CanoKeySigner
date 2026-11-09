import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { WebUsbTransport, waitForDeviceSelection } from '../src/device/webusb';

function mockDevice() {
  const calls: { name: string; setup?: USBControlTransferParameters; length?: number }[] = [];
  const alternate = { interfaceClass: 0xff, interfaceSubclass: 0xff, interfaceProtocol: 0xff,
    endpoints: [], alternateSetting: 0 };
  const device = {
    opened: false,
    configuration: { interfaces: [{ interfaceNumber: 3, alternate, alternates: [alternate] }] },
    async open() { calls.push({ name: 'open' }); device.opened = true; },
    async close() { calls.push({ name: 'close' }); device.opened = false; },
    async claimInterface(number: number) { calls.push({ name: `claim${number}` }); },
    async selectAlternateInterface() { throw new Error('3.0.3 SET_INTERFACE would stall'); },
    async controlTransferOut(setup: USBControlTransferParameters, bytes: BufferSource): Promise<USBOutTransferResult> {
      calls.push({ name: 'out', setup });
      return { status: 'ok', bytesWritten: bytes.byteLength };
    },
    async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
      calls.push({ name: 'in', setup, length });
      const bytes = setup.request === 2 ? Uint8Array.of(0) : Uint8Array.of(0x90, 0);
      return { status: 'ok', data: new DataView(bytes.buffer) };
    },
  };
  return { device, calls, usb: device as unknown as USBDevice };
}

test('pending USB selection cancels immediately and ignores a late selected device', async () => {
  const { usb, calls } = mockDevice(), abort = new AbortController();
  let finish!: (device: USBDevice) => void;
  const selection = new Promise<USBDevice>((resolve) => { finish = resolve; });
  let activated = false;
  const pending = waitForDeviceSelection(selection, abort.signal).then((device) => { activated = true; return device; });
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  abort.abort();
  await assert.rejects(pending, /选择已取消/);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  finish(usb); await Promise.resolve();
  assert.equal(activated, false); assert.equal(calls.length, 0);
});

test('late picker rejection after cancellation leaves a newer selection usable', async () => {
  const oldAbort = new AbortController(), nextAbort = new AbortController(), { usb } = mockDevice();
  let rejectOld!: (error: Error) => void, selectNext!: (device: USBDevice) => void;
  const old = waitForDeviceSelection(new Promise<USBDevice>((_resolve, reject) => { rejectOld = reject; }), oldAbort.signal);
  oldAbort.abort(); await assert.rejects(old, /选择已取消/);
  const next = waitForDeviceSelection(new Promise<USBDevice>((resolve) => { selectNext = resolve; }), nextAbort.signal);
  rejectOld(new Error('native picker closed late')); await Promise.resolve();
  selectNext(usb); assert.equal(await next, usb);
  assert.equal(nextAbort.signal.aborted, false);
  assert.equal(getEventListeners(nextAbort.signal, 'abort').length, 0);
});

test('an already cancelled selection consumes late native rejection without adding an abort listener', async () => {
  const abort = new AbortController(); abort.abort();
  let rejectSelection!: (error: Error) => void;
  const selection = new Promise<USBDevice>((_resolve, reject) => { rejectSelection = reject; });
  await assert.rejects(waitForDeviceSelection(selection, abort.signal), /选择已取消/);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  rejectSelection(new Error('late native rejection')); await Promise.resolve();
});

test('successful USB selection releases its abort listener and returns the exact device', async () => {
  const abort = new AbortController(), { usb, calls } = mockDevice();
  const selected = waitForDeviceSelection(Promise.resolve(usb), abort.signal);
  assert.equal(await selected, usb);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  abort.abort(); assert.equal(await selected, usb); assert.equal(calls.length, 0);
});

test('native USB selection errors reach the caller and release the abort listener', async () => {
  const abort = new AbortController(), error = new Error('device access denied');
  await assert.rejects(waitForDeviceSelection(Promise.reject(error), abort.signal), (actual: unknown) => actual === error);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('WebUSB uses dynamic interface index and exact request order, skips SET_INTERFACE', async () => {
  const { usb, calls } = mockDevice();
  const transport = new WebUsbTransport(usb, new AbortController().signal);
  await transport.open();
  assert.deepEqual(await transport.exchange(Uint8Array.of(0, 0x31, 0, 0, 0)), Uint8Array.of(0x90, 0));
  const transfers = calls.filter((call) => call.setup);
  assert.deepEqual(transfers.map((call) => call.setup!.request), [0, 2, 1]);
  assert.equal(transfers[2]!.length, 1342);
  for (const { setup } of transfers) {
    assert.equal(setup!.index, 3);
    assert.equal(setup!.recipient, 'interface');
    assert.equal(setup!.requestType, 'vendor');
    assert.equal(setup!.value, 0);
  }
  await transport.close();
  await assert.rejects(transport.exchange(Uint8Array.of(0, 0x31, 0, 0)), /关闭/);
});

test('an already opened handle is left with its original owner', async () => {
  const { usb, device, calls } = mockDevice();
  device.opened = true;
  const transport = new WebUsbTransport(usb, new AbortController().signal);
  await assert.rejects(transport.open(), /活动连接/);
  await transport.close();
  assert.equal(device.opened, true);
  assert.equal(calls.length, 0);
});

test('failed transfer closes the session with no automatic resend', async () => {
  const { usb, device, calls } = mockDevice();
  device.controlTransferOut = async (setup) => {
    calls.push({ name: 'out', setup });
    return { status: 'stall', bytesWritten: 0 };
  };
  const transport = new WebUsbTransport(usb, new AbortController().signal);
  await transport.open();
  await assert.rejects(transport.exchange(Uint8Array.of(0, 0x31, 0, 0)), /发送失败/);
  assert.equal(calls.filter((call) => call.name === 'out').length, 1);
  assert.equal(device.opened, false);
});

test('cancelled pending transfer cannot produce a usable late result or accept another APDU', async () => {
  const { usb, device, calls } = mockDevice();
  const abort = new AbortController();
  let finish: ((value: USBOutTransferResult) => void) | undefined;
  device.controlTransferOut = () => new Promise((resolve) => { finish = resolve; });
  const transport = new WebUsbTransport(usb, abort.signal);
  await transport.open();
  const pending = transport.exchange(Uint8Array.of(0, 0x31, 0, 0));
  await assert.rejects(transport.exchange(Uint8Array.of(0, 0x31, 0, 0)), /活动 APDU/);
  abort.abort();
  await assert.rejects(pending, /取消/);
  finish!({ status: 'ok', bytesWritten: 4 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.some((call) => call.name === 'in'), false);
  assert.equal(device.opened, false);
  await assert.rejects(transport.exchange(Uint8Array.of(0, 0x31, 0, 0)), /关闭/);
});

test('timeout invalidates pending operations and suppresses late response processing', async (context) => {
  const { usb, device, calls } = mockDevice();
  device.controlTransferOut = () => new Promise(() => undefined);
  const transport = new WebUsbTransport(usb, new AbortController().signal);
  await transport.open();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = transport.exchange(Uint8Array.of(0, 0x31, 0, 0));
  context.mock.timers.tick(10_000);
  await assert.rejects(pending, /超时/);
  assert.equal(device.opened, false);
  assert.equal(calls.some((call) => call.name === 'in'), false);
});

test('late response from a disconnected session cannot close a new owner handle', async () => {
  const { usb, device, calls } = mockDevice();
  const abort = new AbortController();
  let finish: ((value: USBOutTransferResult) => void) | undefined;
  device.controlTransferOut = () => new Promise((resolve) => { finish = resolve; });
  const transport = new WebUsbTransport(usb, abort.signal);
  await transport.open();
  const pending = transport.exchange(Uint8Array.of(0, 0x31, 0, 0));
  device.opened = false;
  abort.abort();
  await assert.rejects(pending, /取消/);
  // Simulate another owner opening the reconnected USBDevice object.
  device.opened = true;
  finish!({ status: 'ok', bytesWritten: 4 });
  await Promise.resolve();
  await Promise.resolve();
  await transport.close();
  assert.equal(device.opened, true);
  assert.equal(calls.some((call) => call.name === 'close'), false);
});

test('touch-enabled signing sessions wait beyond the read-only timeout and wipe copied commands', async (context) => {
  const { usb, device } = mockDevice();
  let payload: Uint8Array | undefined;
  device.controlTransferOut = async (_setup, bytes) => {
    payload = bytes as Uint8Array;
    return new Promise(() => undefined);
  };
  const transport = new WebUsbTransport(usb, new AbortController().signal, 45_000);
  await transport.open();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = transport.exchange(Uint8Array.of(0, 0x20, 0, 0x81, 6, 1, 2, 3, 4, 5, 6));
  void pending.then(() => { settled = true; }, () => { settled = true; });
  context.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(device.opened, true);
  context.mock.timers.tick(35_000);
  await assert.rejects(pending, /超时/);
  assert.ok(payload!.every((byte) => byte === 0));
  assert.equal(device.opened, false);
});
