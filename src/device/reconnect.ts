/** Retry device acquisition only. Once signing starts, no command is replayed. */
export async function runWithUsbReconnect<T>(options: {
  usb: EventTarget & Pick<USB, 'getDevices'>;
  signal: AbortSignal;
  serialNumber?: string | undefined;
  preferred?(): USBDevice | undefined;
  ready(): boolean;
  waiting(): void;
  missing?(): void;
  attempt(device: USBDevice, abort: AbortController, start: () => void): Promise<T>;
  timeoutMs?: number;
}): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  options.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, options.timeoutMs ?? 120000);
  let started = false;
  if (options.signal.aborted) abort.abort();
  function check(): void {
    if (abort.signal.aborted) throw new Error(options.signal.aborted ? '已取消等待或签名' : '等待 CanoKey 超时，请重新审查后重试');
  }
  function bounded<R>(promise: Promise<R>): Promise<R> {
    return new Promise((resolve, reject) => {
      const onAbort = () => { cleanup(); try { check(); } catch (error) { reject(error); } };
      const cleanup = () => abort.signal.removeEventListener('abort', onAbort);
      abort.signal.addEventListener('abort', onAbort, { once: true });
      promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
      if (abort.signal.aborted) onAbort();
    });
  }
  function pause(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(poll);
        options.usb.removeEventListener('connect', finish);
        abort.signal.removeEventListener('abort', finish);
        resolve();
      };
      const poll = setTimeout(finish, 200);
      options.usb.addEventListener('connect', finish, { once: true });
      abort.signal.addEventListener('abort', finish, { once: true });
      if (abort.signal.aborted) finish();
    });
  }
  try {
    for (;;) {
      check();
      try {
        const devices = await bounded(options.usb.getDevices());
        check();
        const matches = devices.filter((device) => device.vendorId === 0x20a0 && device.productId === 0x42d4
          && (!options.serialNumber || device.serialNumber === options.serialNumber));
        if (!matches.length) options.missing?.();
        const preferred = options.preferred?.();
        const selected = preferred && matches.includes(preferred) ? preferred : matches.length === 1 ? matches[0] : undefined;
        if (selected && options.ready()) {
          return await bounded(options.attempt(selected, abort, () => {
            check();
            started = true;
            clearTimeout(timer);
          }));
        }
      } catch (error) {
        check();
        if (started) throw error;
      }
      options.waiting();
      await pause();
    }
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', cancel);
  }
}
