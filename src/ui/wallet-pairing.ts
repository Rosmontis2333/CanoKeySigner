export function mountWalletPairing(connect: (uri: string) => Promise<void>, cancelPairing: () => void) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>('wc-dialog'), input = get<HTMLTextAreaElement>('wc-uri');
  const pair = get<HTMLButtonElement>('wc-pair'), camera = get<HTMLButtonElement>('wc-camera');
  const stop = get<HTMLButtonElement>('wc-camera-stop'), video = get<HTMLVideoElement>('wc-camera-video');
  const status = get('wc-dialog-status'), accountHint = get('wc-dialog-account');
  let ready = false, pairing = false, scanning = false, generation = 0;
  let stream: MediaStream | undefined, timer: ReturnType<typeof setTimeout> | undefined;

  function stopCamera(): void {
    generation++; scanning = false; clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
    video.pause(); video.srcObject = null; video.hidden = stop.hidden = true;
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
  camera.addEventListener('click', () => {
    if (scanning || pairing || !__WALLETCONNECT__) return;
    if (!navigator.mediaDevices?.getUserMedia) { status.textContent = '当前浏览器无法使用摄像头，请输入连接地址。'; return; }
    scanning = true; camera.disabled = true; stop.hidden = false;
    const revision = ++generation;
    status.textContent = '请允许使用摄像头，将 dApp 的连接二维码放入画面。';
    void (async () => {
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } });
        if (revision !== generation || !dialog.open) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream = acquired; video.srcObject = acquired; video.hidden = false;
        await video.play();
        if (revision !== generation || !dialog.open) return;
        const decoder = __WALLETCONNECT__ ? await import('jsqr') : undefined;
        if (revision !== generation || !dialog.open || !decoder) return;
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('当前浏览器无法读取摄像头画面，请输入连接地址。');
        status.textContent = '正在扫描 WalletConnect 二维码…';
        const scan = () => {
          if (revision !== generation || !dialog.open) return;
          try {
            if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
              const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
              canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
              const code = decoder.default(pixels.data, pixels.width, pixels.height);
              if (code) {
                if (code.data.startsWith('wc:') && code.data.length <= 2048) {
                  input.value = code.data; stopCamera(); status.textContent = '已识别连接地址，请确认后点击连接。'; input.focus(); return;
                }
                status.textContent = '请扫描 dApp 提供的 WalletConnect 连接二维码。';
              }
            }
            timer = setTimeout(scan, 200);
          } catch { stopCamera(); status.textContent = '读取画面失败，请重启摄像头或输入连接地址。'; }
        };
        scan();
      } catch (error) {
        if (revision !== generation) return;
        stopCamera();
        status.textContent = error instanceof DOMException && error.name === 'NotAllowedError'
          ? '摄像头权限未开启，可以直接输入连接地址。' : '摄像头启动失败，请检查设备或输入连接地址。';
      }
    })();
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
