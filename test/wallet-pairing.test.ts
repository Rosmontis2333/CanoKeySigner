import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mountWalletPairing } from '../src/ui/wallet-pairing';

class Element extends EventTarget {
  value = ''; textContent = ''; disabled = false; hidden = false; open = false;
  srcObject: unknown = null;
  play: () => Promise<void> = async () => undefined;
  pause() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  click() { this.dispatchEvent(new Event('click')); }
}
function fixture(context: TestContext, media: () => Promise<MediaStream>, connect: (uri: string) => Promise<void> = async () => undefined) {
  const elements = new Map(['wc-dialog', 'wc-uri', 'wc-pair', 'wc-camera', 'wc-camera-stop', 'wc-camera-video',
    'wc-dialog-status', 'wc-dialog-account', 'wc-dialog-close'].map((name) => [name, new Element()]));
  const document = Object.assign(new EventTarget(), { getElementById: (name: string) => elements.get(name), hidden: false });
  const replacements = { document, window: new EventTarget(), navigator: { mediaDevices: { getUserMedia: media } }, __WALLETCONNECT__: true };
  for (const [name, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    context.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  let cancelled = 0;
  const app = mountWalletPairing(connect, () => { cancelled++; });
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
