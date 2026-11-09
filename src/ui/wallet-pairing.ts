export function mountWalletPairing(connect: (uri: string) => Promise<void>, cancelPairing: () => void) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>('wc-dialog'), input = get<HTMLTextAreaElement>('wc-uri');
  const pair = get<HTMLButtonElement>('wc-pair'), camera = get<HTMLButtonElement>('wc-camera');
  const stop = get<HTMLButtonElement>('wc-camera-stop'), video = get<HTMLVideoElement>('wc-camera-video');
  const status = get('wc-dialog-status'), accountHint = get('wc-dialog-account');
  const cameraSelect = get<HTMLSelectElement>('wc-camera-select'), cameraChoice = get('wc-camera-choice');
  const preview = get('wc-camera-preview'), cameraHint = get('wc-camera-hint');
  let ready = false, pairing = false, scanning = false, generation = 0;
  let stream: MediaStream | undefined, timer: ReturnType<typeof setTimeout> | undefined;

  function stopCamera(): void {
    generation++; scanning = false; clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
    video.pause(); video.srcObject = null; video.hidden = stop.hidden = true;
    preview.hidden = cameraChoice.hidden = cameraHint.hidden = true;
    camera.disabled = pairing;
  }
  function close(): void {
    stopCamera(); input.value = ''; status.textContent = '';
    if (pairing) cancelPairing();
    pairing = false; pair.disabled = !ready;
  }
  dialog.addEventListener('close', () => { if (!dialog.open) close(); });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  get('wc-dialog-close').addEventListener('click', () => dialog.close());
  stop.addEventListener('click', () => { stopCamera(); status.textContent = '摄像头已关闭，可以继续输入连接地址。'; });
  async function listCameras(revision: number, track: MediaStreamTrack | undefined): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices?.() ?? [];
      if (revision !== generation || !scanning || !dialog.open) return;
      cameraSelect.replaceChildren();
      const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
      cameras.forEach((device, index) => {
        const option = document.createElement('option'); option.value = device.deviceId;
        option.textContent = device.label || `摄像头 ${index + 1}`; cameraSelect.append(option);
      });
      const active = track?.getSettings?.().deviceId;
      if (active) cameraSelect.value = active;
      cameraSelect.disabled = false; cameraChoice.hidden = cameras.length < 2;
    } catch { /* Camera selection is optional when enumeration is unavailable. */ }
  }
  function startCamera(deviceId?: string): void {
    if (scanning || pairing || !__WALLETCONNECT__) return;
    if (!navigator.mediaDevices?.getUserMedia) { status.textContent = '当前浏览器无法使用摄像头，请输入连接地址。'; return; }
    scanning = true; camera.disabled = cameraSelect.disabled = true; stop.hidden = false;
    const revision = ++generation;
    status.textContent = '请允许使用摄像头，将 dApp 的连接二维码放入画面。';
    void (async () => {
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1920 }, height: { ideal: 1080 },
        } });
        if (revision !== generation || !dialog.open) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream = acquired; video.srcObject = acquired; video.hidden = preview.hidden = cameraHint.hidden = false;
        const track = acquired.getVideoTracks?.()[0];
        void listCameras(revision, track);
        try {
          const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { focusMode?: string[] }) | undefined;
          if (capabilities?.focusMode?.includes('continuous')) {
            void track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
          }
        } catch { /* Use the camera's default focus when focus controls are unavailable. */ }
        await video.play();
        if (revision !== generation || !dialog.open) return;
        const decoder = __WALLETCONNECT__ ? await import('./qr-scanner') : undefined;
        if (revision !== generation || !dialog.open || !decoder) return;
        const current = () => revision === generation && dialog.open && scanning;
        const decode = decoder.createQrScanner(video, current);
        status.textContent = '正在扫描，请将完整二维码保持在画面中…';
        const scan = async () => {
          if (!current()) return;
          try {
            const uri = await decode();
            if (!current()) return;
            if (uri) {
              input.value = uri; stopCamera(); status.textContent = '已识别连接地址，请确认后点击连接。'; input.focus(); return;
            }
            timer = setTimeout(() => { void scan(); }, 100);
          } catch {
            if (!current()) return;
            stopCamera(); status.textContent = '读取画面失败，请重启摄像头或输入连接地址。';
          }
        };
        void scan();
      } catch (error) {
        if (revision !== generation) return;
        stopCamera(); cameraSelect.value = '';
        status.textContent = error instanceof DOMException && error.name === 'NotAllowedError'
          ? '摄像头权限未开启，可以直接输入连接地址。' : '摄像头启动失败，请检查设备或输入连接地址。';
      }
    })();
  }
  camera.addEventListener('click', () => startCamera(cameraSelect.value || undefined));
  cameraSelect.addEventListener('change', () => {
    if (!scanning || pairing) return;
    const deviceId = cameraSelect.value; stopCamera(); startCamera(deviceId);
  });
  pair.addEventListener('click', () => {
    if (!ready || pairing) return;
    const uri = input.value.trim();
    if (!uri) { status.textContent = '请输入或扫描 WalletConnect 连接地址。'; input.focus(); return; }
    stopCamera(); const revision = generation;
    pairing = true; pair.disabled = camera.disabled = true; status.textContent = '正在连接 dApp…';
    void connect(uri).then(() => {
      if (revision !== generation || !dialog.open) return;
      pairing = false; dialog.close();
    }).catch((error: unknown) => {
      if (revision !== generation || !dialog.open) return;
      pairing = false; pair.disabled = !ready; camera.disabled = false;
      status.textContent = error instanceof Error ? error.message : '连接失败，请检查连接地址。';
    });
  });
  window.addEventListener('pagehide', () => { stopCamera(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && scanning) { stopCamera(); status.textContent = '摄像头已关闭。'; } });
  return {
    open() { if (!dialog.open) { status.textContent = ''; dialog.showModal(); } },
    reset() { if (dialog.open) dialog.close(); close(); },
    setReady(value: boolean) {
      ready = value; pair.disabled = !ready || pairing;
      accountHint.textContent = ready ? '连接将使用左侧当前选择的账户。' : '请先连接 CanoKey 并选择签名账户，再确认连接。';
    },
  };
}
