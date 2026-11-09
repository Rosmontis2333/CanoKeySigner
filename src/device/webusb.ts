import { MAX_COMMAND_BYTES, MAX_RESPONSE_BYTES } from './apdu';
import type { ApduTransport } from './apdu';

const TRANSFER_TIMEOUT_MS = 10_000;

/** WebUSB has no signal parameter for the native picker. Ignore its result after cancellation. */
export function waitForDeviceSelection(selection: Promise<USBDevice>, signal: AbortSignal): Promise<USBDevice> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(new Error('设备选择已取消'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    selection.then((device) => {
      signal.removeEventListener('abort', cancel);
      resolve(device);
    }, (error: unknown) => {
      signal.removeEventListener('abort', cancel);
      reject(error);
    });
    if (signal.aborted) cancel();
  });
}

/** One disposable session. Timeout/abort permanently closes it. */
export class WebUsbTransport implements ApduTransport {
  private active = true;
  private interfaceNumber: number | undefined;
  private exchanging = false;
  private ownsHandle = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly device: USBDevice,
    private readonly signal: AbortSignal,
    private readonly exchangeTimeoutMs = TRANSFER_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(exchangeTimeoutMs) || exchangeTimeoutMs < 1 || exchangeTimeoutMs > 120_000) {
      throw new Error('Invalid USB exchange timeout');
    }
  }

  async open(): Promise<void> {
    await this.bounded(async () => {
      if (this.device.opened) throw new Error('设备已有活动连接，请关闭其他设备工具');
      await this.device.open();
      this.ownsHandle = true;
      this.assertActive();
      if (!this.device.configuration) await this.device.selectConfiguration(1);
      this.assertActive();
      const matches = this.device.configuration?.interfaces.flatMap((item) =>
        item.alternates.filter((alternate) => alternate.interfaceClass === 0xff
          && alternate.interfaceSubclass === 0xff && alternate.interfaceProtocol === 0xff
          && alternate.endpoints.length === 0)
          .map((alternate) => ({ interfaceNumber: item.interfaceNumber, alternate: alternate.alternateSetting })),
      ) ?? [];
      if (matches.length !== 1) throw new Error('无法唯一识别 CanoKey WebUSB 接口');
      const match = matches[0]!;
      this.interfaceNumber = match.interfaceNumber;
      await this.device.claimInterface(match.interfaceNumber);
      this.assertActive();
      const current = this.device.configuration?.interfaces.find((item) => item.interfaceNumber === match.interfaceNumber);
      // core 3.0.3 does not handle SET_INTERFACE for its already active alternate 0.
      if (current?.alternate.alternateSetting !== match.alternate) {
        await this.device.selectAlternateInterface(match.interfaceNumber, match.alternate);
        this.assertActive();
      }
    });
  }

  async exchange(command: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    if (this.exchanging) throw new Error('设备已有活动 APDU');
    if (command.length < 4 || command.length > MAX_COMMAND_BYTES) throw new Error('APDU 长度超出范围');
    if (this.interfaceNumber === undefined) throw new Error('设备接口尚未打开');
    this.exchanging = true;
    const payload = command.slice();
    try {
      return await this.bounded(async () => {
        const setup = {
          requestType: 'vendor', recipient: 'interface', value: 0, index: this.interfaceNumber!,
        } as const;
        const sent = await this.device.controlTransferOut({ ...setup, request: 0 }, payload);
        this.assertActive();
        if (sent.status !== 'ok' || sent.bytesWritten !== payload.length) throw new Error('WebUSB 发送失败');
        for (;;) {
          const result = await this.device.controlTransferIn({ ...setup, request: 2 }, 1);
          this.assertActive();
          if (result.status !== 'ok' || result.data?.byteLength !== 1) throw new Error('WebUSB 状态读取失败');
          const state = result.data.getUint8(0);
          if (state === 0) break;
          if (state !== 1) throw new Error(`设备返回意外状态 0x${state.toString(16)}`);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          this.assertActive();
        }
        const result = await this.device.controlTransferIn({ ...setup, request: 1 }, MAX_RESPONSE_BYTES);
        this.assertActive();
        if (result.status !== 'ok' || !result.data) throw new Error('WebUSB 响应读取失败');
        return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
      }, this.exchangeTimeoutMs);
    } finally {
      payload.fill(0);
      this.exchanging = false;
    }
  }

  async close(): Promise<void> {
    this.active = false;
    if (this.closing) return this.closing;
    const owned = this.ownsHandle;
    this.ownsHandle = false;
    if (owned && this.device.opened) {
      this.closing = this.device.close();
      await this.closing;
    }
  }

  private assertActive(): void {
    if (!this.active || this.signal.aborted) {
      // A late open/transfer completion must not leave a usable session behind.
      void this.close().catch(() => undefined);
      throw new Error('设备检查已取消或连接已关闭');
    }
  }

  private async bounded<T>(operation: () => Promise<T>, timeoutMs = TRANSFER_TIMEOUT_MS): Promise<T> {
    this.assertActive();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      const invalidate = (message: string) => {
        void this.close().catch(() => undefined);
        reject(new Error(message));
      };
      onAbort = () => invalidate('设备检查已取消');
      this.signal.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => invalidate('设备响应超时，请拔插设备后重新连接'), timeoutMs);
    });
    try {
      return await Promise.race([operation(), cancellation]);
    } catch (error) {
      void this.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.signal.removeEventListener('abort', onAbort);
    }
  }
}
