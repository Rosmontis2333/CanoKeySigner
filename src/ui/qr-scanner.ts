import jsQR from 'jsqr';

interface NativeDetector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

function walletUri(value: string | undefined): string | undefined {
  const uri = value?.trim();
  return uri && uri.length <= 2048 && /^wc:[0-9a-f]{64}@2\?/.test(uri) ? uri : undefined;
}

/** Keep camera pixels for dense codes. Crop and full-frame passes cover different QR sizes. */
export function createQrScanner(video: HTMLVideoElement, current: () => boolean) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器无法读取摄像头画面，请输入连接地址。');
  const Detector = (globalThis as typeof globalThis & {
    BarcodeDetector?: new (options: { formats: string[] }) => NativeDetector;
  }).BarcodeDetector;
  let native: NativeDetector | undefined;
  try { if (Detector) native = new Detector({ formats: ['qr_code'] }); } catch { /* Use the bundled decoder. */ }
  let frame = 0;

  return async (): Promise<string | undefined> => {
    if (!current() || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    if (native) {
      try {
        const codes = await native.detect(video);
        if (!current()) return;
        for (const code of codes) {
          const uri = walletUri(code.rawValue);
          if (uri) return uri;
        }
      } catch {
        // Some browsers expose the API but cannot decode on this device.
        native = undefined;
      }
    }
    if (!current()) return;
    const width = video.videoWidth, height = video.videoHeight;
    const side = Math.round(Math.min(width, height) * 0.8);
    const regions = [
      { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side, limit: 1024 },
      { x: 0, y: 0, width, height, limit: frame++ % 2 ? 1920 : 1280 },
    ];
    for (const region of regions) {
      const scale = Math.min(1, region.limit / Math.max(region.width, region.height));
      canvas.width = Math.max(1, Math.round(region.width * scale));
      canvas.height = Math.max(1, Math.round(region.height * scale));
      context.imageSmoothingEnabled = false;
      context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
      const uri = walletUri(code?.data);
      if (uri) return uri;
    }
  };
}
