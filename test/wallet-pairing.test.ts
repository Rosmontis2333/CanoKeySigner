import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mountWalletPairing } from '../src/ui/wallet-pairing';
import '../src/ui/qr-scanner';

const scanUri = 'wc:' + '01'.repeat(32) + '@2?relay-protocol=irn&symKey=' + '02'.repeat(32);

class Element extends EventTarget {
  value = ''; textContent = ''; disabled = false; hidden = false; open = false;
  srcObject: unknown = null;
  readyState = 2; videoWidth = 1920; videoHeight = 1080;
  children: Element[] = [];
  replaceChildren() { this.children = []; }
  append(element: Element) { this.children.push(element); }
  play: () => Promise<void> = async () => undefined;
  pause() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  click() { this.dispatchEvent(new Event('click')); }
}
function fixture(context: TestContext, media: (constraints: MediaStreamConstraints) => Promise<MediaStream>, connect: (uri: string) => Promise<void> = async () => undefined,
  options: { detector?: unknown; devices?: MediaDeviceInfo[] } = {}) {
  const elements = new Map(['wc-dialog', 'wc-uri', 'wc-pair', 'wc-camera', 'wc-camera-stop', 'wc-camera-video',
    'wc-dialog-status', 'wc-dialog-account', 'wc-dialog-close', 'wc-camera-choice', 'wc-camera-select', 'wc-camera-preview', 'wc-camera-hint'].map((name) => [name, new Element()]));
  const document = Object.assign(new EventTarget(), { getElementById: (name: string) => elements.get(name), hidden: false,
    createElement: (tag: string) => tag === 'option' ? new Element() : { getContext: () => ({
      drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 }),
    }) },
  });
  const replacements = { document, window: new EventTarget(), navigator: { mediaDevices: { getUserMedia: media, enumerateDevices: async () => options.devices ?? [] } },
    BarcodeDetector: options.detector, __WALLETCONNECT__: true };
  for (const [name, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    context.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  let cancelled = 0;
  const app = mountWalletPairing(connect, () => { cancelled++; });
  context.after(() => app.reset());
  return { app, get: (name: string) => elements.get(name)!, cancelled: () => cancelled };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('closing while camera permission is pending stops every late media track', async (context) => {
  let grant!: (stream: MediaStream) => void, stopped = 0;
  const f = fixture(context, () => new Promise<MediaStream>((resolve) => { grant = resolve; }));
  f.app.open(); f.get('wc-camera').click(); f.get('wc-dialog-close').click();
  grant({ getTracks: () => [{ stop: () => { stopped++; } }] } as unknown as MediaStream);
  await flush();
  assert.equal(stopped, 1); assert.equal(f.get('wc-camera-video').srcObject, null);
  assert.equal(f.get('wc-dialog').open, false);
});

test('account changes release an acquired camera while video playback is pending', async (context) => {
  let stopped = 0, play!: () => void;
  const f = fixture(context, async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) as unknown as MediaStream);
  f.get('wc-camera-video').play = () => new Promise<void>((resolve) => { play = resolve; });
  f.app.open(); f.get('wc-camera').click(); await flush();
  f.app.reset(); play(); await flush();
  assert.equal(stopped, 1); assert.equal(f.get('wc-camera-video').srcObject, null);
  assert.equal(f.get('wc-dialog').open, false);
});

test('camera denial preserves manual input and keeps the connection action available', async (context) => {
  let connected = '';
  const f = fixture(context, async () => { throw new DOMException('denied', 'NotAllowedError'); }, async (uri) => { connected = uri; });
  f.app.setReady(true); f.app.open(); f.get('wc-uri').value = 'wc:synthetic-test';
  f.get('wc-camera').click(); await flush();
  assert.match(f.get('wc-dialog-status').textContent, /权限未开启/);
  assert.equal(f.get('wc-camera').disabled, false); assert.equal(f.get('wc-uri').value, 'wc:synthetic-test');
  f.get('wc-pair').click(); await flush();
  assert.equal(connected, 'wc:synthetic-test'); assert.equal(f.get('wc-dialog').open, false);
  assert.equal(f.cancelled(), 0);
});

test('closing a pending connection cancels it and its late result leaves a reopened dialog intact', async (context) => {
  let finish!: () => void;
  const f = fixture(context, async () => { throw new Error('unused'); }, () => new Promise<void>((resolve) => { finish = resolve; }));
  f.app.open(); f.get('wc-uri').value = 'wc:synthetic'; f.get('wc-pair').click();
  assert.equal(f.get('wc-dialog').open, true); assert.equal(f.cancelled(), 0);
  f.app.setReady(true); f.get('wc-pair').click(); f.get('wc-dialog-close').click();
  assert.equal(f.cancelled(), 1);
  f.app.open(); f.get('wc-uri').value = 'wc:new-request'; finish(); await flush();
  assert.equal(f.get('wc-dialog').open, true); assert.equal(f.get('wc-uri').value, 'wc:new-request');
  f.app.reset();
});

test('successful camera decoding fills the URI, releases tracks and waits for explicit connection', async (context) => {
  let stopped = 0, connected = 0, constraints: MediaStreamConstraints | undefined;
  class Detector { async detect() { return [{ rawValue: scanUri }]; } }
  const f = fixture(context, async (requested) => {
    constraints = requested;
    return { getTracks: () => [{ stop: () => { stopped++; } }] } as unknown as MediaStream;
  }, async () => { connected++; }, { detector: Detector });
  f.app.setReady(true); f.app.open(); f.get('wc-camera').click();
  for (let i = 0; i < 20 && !f.get('wc-uri').value; i++) await flush();
  assert.equal(f.get('wc-uri').value, scanUri);
  assert.equal(connected, 0); assert.equal(stopped, 1);
  assert.equal(f.get('wc-camera-preview').hidden, true);
  assert.deepEqual(constraints?.video, { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } });
  f.get('wc-pair').click(); await flush();
  assert.equal(connected, 1);
});

test('camera switching closes the previous stream and rejects late detection from that camera', async (context) => {
  let finish!: (codes: { rawValue: string }[]) => void;
  let calls = 0, stopped = 0, focused = 0;
  const requests: MediaStreamConstraints[] = [];
  class Detector { detect() { return new Promise<{ rawValue: string }[]>((resolve) => { finish = resolve; }); } }
  const f = fixture(context, async (requested) => {
    requests.push(requested); const id = ++calls;
    const track = { stop: () => { stopped++; }, getSettings: () => ({ deviceId: id === 1 ? 'front' : 'back' }),
      getCapabilities: () => ({ focusMode: ['continuous'] }), applyConstraints: async () => { focused++; } };
    return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  }, async () => undefined, { detector: Detector, devices: [
    { deviceId: 'front', label: 'Front', kind: 'videoinput' }, { deviceId: 'back', label: 'Back', kind: 'videoinput' },
  ] as MediaDeviceInfo[] });
  f.app.open(); f.get('wc-camera').click();
  for (let i = 0; i < 20 && !finish; i++) await flush();
  assert.equal(f.get('wc-camera-choice').hidden, false);
  assert.equal(f.get('wc-camera-select').value, 'front');
  const oldResult = finish;
  f.get('wc-camera-select').value = 'back'; f.get('wc-camera-select').dispatchEvent(new Event('change'));
  assert.equal(stopped, 1);
  oldResult([{ rawValue: scanUri }]); await flush();
  assert.equal(f.get('wc-uri').value, '');
  assert.deepEqual((requests[1]?.video as MediaTrackConstraints).deviceId, { exact: 'back' });
  assert.equal(focused, 2);
  f.get('wc-dialog-close').click();
  assert.equal(stopped, 2);
});
