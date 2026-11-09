import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import jsQR from 'jsqr';
import { createQrScanner } from '../src/ui/qr-scanner';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/walletconnect-qr.json', import.meta.url), 'utf8')) as { uri: string; rows: string[] };

function setup(context: TestContext, options: { x?: number; y?: number; inverted?: boolean; rotated?: boolean; detector?: unknown } = {}) {
  const video = { readyState: 2, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
  const drawn: number[][] = [];
  const canvas = { width: 0, height: 0, getContext: () => drawing };
  let region: number[] = [];
  const drawing = {
    imageSmoothingEnabled: true,
    drawImage(_video: unknown, ...coordinates: number[]) { region = coordinates; drawn.push(coordinates); },
    getImageData() {
      const [x, y, width, height] = region as [number, number, number, number];
      const pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      const side = fixture.rows.length, modulePixels = 3, quiet = 4;
      const qrSize = (side + quiet * 2) * modulePixels;
      const left = options.x ?? Math.floor((video.videoWidth - qrSize) / 2);
      const top = options.y ?? Math.floor((video.videoHeight - qrSize) / 2);
      for (let row = 0; row < canvas.height; row++) for (let column = 0; column < canvas.width; column++) {
        const sourceX = x + (column + 0.5) * width / canvas.width;
        const sourceY = y + (row + 0.5) * height / canvas.height;
        const qx = Math.floor((sourceX - left) / modulePixels) - quiet;
        const qy = Math.floor((sourceY - top) / modulePixels) - quiet;
        const black = (options.rotated ? fixture.rows[side - 1 - qx]?.[qy] : fixture.rows[qy]?.[qx]) === '1';
        const value = black !== !!options.inverted ? 50 : 220;
        const offset = (row * canvas.width + column) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value; pixels[offset + 3] = 255;
      }
      return { data: pixels, width: canvas.width, height: canvas.height };
    },
  };
  for (const [name, value] of Object.entries({ document: { createElement: () => canvas }, BarcodeDetector: options.detector })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    context.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  return { video, drawn, canvas, drawing };
}

test('dense WalletConnect code lost at 720px is decoded from the camera center at full detail', async (context) => {
  const f = setup(context);
  f.canvas.width = 720; f.canvas.height = 405;
  f.drawing.drawImage(f.video, 0, 0, 1920, 1080, 0, 0, 720, 405);
  const legacy = f.drawing.getImageData();
  assert.equal(jsQR(legacy.data, legacy.width, legacy.height), null);
  assert.equal(await createQrScanner(f.video, () => true)(), fixture.uri);
});

test('inverted and rotated dense codes decode without native barcode support', async (context) => {
  const f = setup(context, { inverted: true, rotated: true });
  assert.equal(await createQrScanner(f.video, () => true)(), fixture.uri);
});

test('off-center dense codes are recovered by the full resolution pass', async (context) => {
  const f = setup(context, { x: 1500, y: 60 });
  const scan = createQrScanner(f.video, () => true);
  const result = await scan() ?? await scan();
  assert.equal(result, fixture.uri);
  assert.ok(f.drawn.some((region) => region[0] === 0 && region[2] === 1920));
});

test('native detection ignores unrelated codes and returns a WalletConnect URI without copying pixels', async (context) => {
  class Detector {
    async detect() { return [{ rawValue: 'https://example.org' }, { rawValue: fixture.uri }]; }
  }
  const f = setup(context, { detector: Detector });
  assert.equal(await createQrScanner(f.video, () => true)(), fixture.uri);
  assert.equal(f.drawn.length, 0);
});

test('an exposed but broken native detector falls back to bundled decoding', async (context) => {
  let calls = 0;
  class Detector {
    async detect() { calls++; throw new Error('unsupported backend'); }
  }
  const f = setup(context, { detector: Detector });
  const scan = createQrScanner(f.video, () => true);
  assert.equal(await scan(), fixture.uri);
  assert.equal(await scan(), fixture.uri);
  assert.equal(calls, 1);
});

test('closing the scanner while native decoding is pending discards its late URI and avoids pixel reads', async (context) => {
  let finish!: (codes: { rawValue: string }[]) => void;
  class Detector {
    detect() { return new Promise<{ rawValue: string }[]>((resolve) => { finish = resolve; }); }
  }
  const f = setup(context, { detector: Detector });
  let active = true;
  const pending = createQrScanner(f.video, () => active)();
  active = false; finish([{ rawValue: fixture.uri }]);
  assert.equal(await pending, undefined);
  assert.equal(f.drawn.length, 0);
});
