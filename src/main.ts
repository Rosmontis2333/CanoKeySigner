import { runWithUsbReconnect } from './device/reconnect';
import { discoverOpenPgp } from './device/openpgp';
import type { OpenPgpDiscovery } from './device/openpgp';
import { WebUsbTransport, waitForDeviceSelection } from './device/webusb';
import { mountTransactionApp } from './ui/transaction';
import { accountAddresses, accountChain } from './ui/accounts';
import type { Coin, WalletAccount } from './ui/accounts';
import { createWalletConnection } from './connectors/walletconnect/client';
import { walletSendsTransaction } from './connectors/walletconnect/policy';
import type { DeviceAccess } from './signing/execute';
import { evmNetworkLabel, evmChainReference } from './chains/evm/networks';
import { mountWalletSubmission } from './ui/wallet-submission';
import { mountWalletPairing } from './ui/wallet-pairing';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connect = get<HTMLButtonElement>('connect'), reconnect = get<HTMLButtonElement>('reconnect'), cancel = get<HTMLButtonElement>('cancel');
const slot = get<HTMLSelectElement>('account-slot'), address = get<HTMLSelectElement>('account-address');
const accountNetwork = get('account-network'), currentAddress = get('current-address'), copy = get<HTMLButtonElement>('copy-address');
const status = get('status'), detail = get('account-detail'), connection = get('connection');
let coin: Coin = 'evm';
let device: USBDevice | undefined;
let discovery: OpenPgpDiscovery | undefined;
let controller: AbortController | undefined;
let requiresReinsert = false;
let deviceSerial: string | undefined;
let preferredDevice: USBDevice | undefined;
let signingTask = false, signingStarted = false;
const deviceWait = get<HTMLDialogElement>('device-wait');
let connectionDialog: ReturnType<typeof mountWalletPairing> | undefined;
const available = window.isSecureContext && 'usb' in navigator && 'locks' in navigator;
const apps = new Map<Coin, ReturnType<typeof mountTransactionApp>>();
const prefix = (chain: Coin) => chain === 'evm' ? 'transaction' : chain;
const network = (chain = coin) => get<HTMLSelectElement>(`${prefix(chain)}-network`);
const selectedNetwork = () => coin === 'evm' ? '' : network().value;
function selectedAccount(): WalletAccount | undefined {
  const key = discovery?.slots.find((key) => key.slot === slot.value);
  if (!key || !address.value || !accountAddresses(coin, key, selectedNetwork()).some((item) => item.address === address.value)) return undefined;
  try { return { coin, slot: key, network: coin === 'evm' ? '' : selectedNetwork(),
    chainId: coin === 'evm' ? '' : accountChain(coin, selectedNetwork()), address: address.value, publicKeyHex: key.publicKeyHex }; }
  catch { return undefined; }
}
function invalidateContext(): void {
  connectionDialog?.reset();
  controller?.abort();
  for (const app of apps.values()) app.invalidate();
  wallet.invalidate();
  requestDialog.close();
}
function refresh(): void {
  const busy = !!controller;
  connect.disabled = reconnect.disabled = !available || busy || requiresReinsert;
  cancel.disabled = !busy;
  slot.disabled = busy || !discovery;
  address.disabled = busy || !address.value;
  address.hidden = get('account-address-label').hidden = coin !== 'bitcoin';
  for (const app of apps.values()) app.refresh();
  for (const chain of ['evm', 'bitcoin', 'solana'] as const) {
    const nativeSlot = get<HTMLSelectElement>(`${prefix(chain)}-slot`);
    if (chain === coin && Array.from(nativeSlot.options).some((item) => item.value === slot.value)) nativeSlot.value = slot.value;
  }
  const account = selectedAccount();
  get('wc-alt-context').hidden = coin !== 'solana';
  currentAddress.textContent = account?.address ?? '等待连接兼容的密钥槽位';
  copy.disabled = !account;
  wcSign.disabled = busy || wcRpcBusy || !wcSignable;
  requestClose.disabled = busy || submissionBusy;
  get('wc-sidebar').hidden = coin === 'bitcoin';
  get<HTMLButtonElement>('wc-open').disabled = !__WALLETCONNECT__ || busy;
  connectionDialog?.setReady(__WALLETCONNECT__ && !busy && !!account && coin !== 'bitcoin');
}
function refreshAccount(resetSlot = false): void {
  const previousSlot = resetSlot ? '' : slot.value;
  slot.replaceChildren();
  for (const key of discovery?.slots ?? []) {
    if (!accountAddresses(coin, key, selectedNetwork()).length) continue;
    const option = document.createElement('option'); option.value = key.slot; option.textContent = `${key.slot} · ${key.algorithm}`; slot.append(option);
  }
  if (Array.from(slot.options).some((option) => option.value === previousSlot)) slot.value = previousSlot;
  if (!slot.options.length) { const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = discovery ? '没有兼容槽位' : '请先连接 CanoKey'; slot.append(placeholder); }
  const previousAddress = address.value;
  address.replaceChildren();
  const key = discovery?.slots.find((key) => key.slot === slot.value);
  if (key) for (const item of accountAddresses(coin, key, selectedNetwork())) {
    const option = document.createElement('option'); option.value = item.address; option.textContent = item.label; address.append(option);
  }
  if (!address.options.length) { const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '等待选择槽位'; address.append(placeholder); }
  if (Array.from(address.options).some((option) => option.value === previousAddress)) address.value = previousAddress;
  detail.textContent = key ? `${key.slot} · ${key.algorithm} · ${key.uifHex.startsWith('00') ? '按槽位策略签名' : '需要触摸确认'}`
    : discovery ? '此币种没有可用算法槽位，请检查现有密钥配置。' : '';
  refresh();
}
async function useDevice<T>(selected: USBDevice, abort: AbortController, signing: boolean,
  operation: (transport: WebUsbTransport) => Promise<T>): Promise<T> {
  return navigator.locks.request('canokeysigner-device', { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('其他标签页正在使用设备');
    const transport = new WebUsbTransport(selected, abort.signal, signing ? 45000 : 10000);
    const onAbort = () => { void transport.close().catch(() => undefined); };
    abort.signal.addEventListener('abort', onAbort, { once: true });
    try { await transport.open(); return await operation(transport); }
    finally { abort.signal.removeEventListener('abort', onAbort); await transport.close(); }
  });
}
const access: DeviceAccess = {
  slots: () => discovery?.slots ?? [], selectedSlot: (chain) => chain === coin ? slot.value : undefined, busy: () => !!controller,
  cancel: () => controller?.abort(), requireReinsert: () => { requiresReinsert = signingStarted && device !== undefined; refresh(); },
  async sign(operation) {
    if (!discovery || controller) throw new Error('请先读取 CanoKey 的账户');
    const abort = new AbortController(); controller = abort;
    signingTask = true; signingStarted = false; refresh();
    try {
      return await runWithUsbReconnect({
        usb: navigator.usb, signal: abort.signal, serialNumber: deviceSerial, preferred: () => preferredDevice,
        ready: () => !requiresReinsert,
        missing() { requiresReinsert = false; device = undefined; },
        waiting() {
          get('device-wait-status').textContent = requiresReinsert
            ? '请拔插 CanoKey，等待恢复连接后继续本次签名。'
            : '正在等待 CanoKey 连接，接入后会核对槽位公钥并继续本次签名。';
          if (!deviceWait.open) deviceWait.showModal();
        },
        attempt(selected, workAbort, start) {
          device = selected;
          return useDevice(selected, workAbort, true, (transport) => {
            start(); signingStarted = true; deviceWait.close();
            connection.textContent = selected.productName ?? 'CanoKey';
            return operation(transport, workAbort.signal);
          });
        },
      });
    } finally {
      deviceWait.close(); signingTask = false;
      controller = undefined; refresh();
    }
  },
};
let activeDapp = '';
const wcReview = get('wc-review'), wcStatus = get('wc-status');
const wcApprove = get<HTMLButtonElement>('wc-approve'), wcReject = get<HTMLButtonElement>('wc-reject');
const wcSign = get<HTMLButtonElement>('wc-sign'), wcPin = get<HTMLInputElement>('wc-pin');
const requestDialog = get<HTMLDialogElement>('wc-request-dialog');
const requestClose = get<HTMLButtonElement>('wc-request-close');
let requestPending = false, submissionBusy = false;
function showRequest(): void {
  if (requestDialog.open) return;
  for (const app of apps.values()) app.invalidate();
  requestDialog.showModal();
}
const wcRpcPane = get('wc-rpc'), wcRpcEndpoint = get<HTMLSelectElement>('wc-rpc-endpoint');
const wcRpcRead = get<HTMLButtonElement>('wc-rpc-read'), wcRpcCancel = get<HTMLButtonElement>('wc-rpc-cancel');
let wcSignable = false, wcRpcBusy = false;
let wcRpcEndpoints: readonly (typeof __EVM_RPC_ENDPOINTS__[number] | typeof __SOLANA_RPC_ENDPOINTS__[number])[] = [];
function row(label: string, value: string): void {
  const term = document.createElement('dt'), description = document.createElement('dd');
  term.textContent = label; description.textContent = value; wcReview.append(term, description);
}
const showWalletSubmission = mountWalletSubmission({
  submit: () => runWallet(() => wallet.submit()), query: () => runWallet(() => wallet.querySubmission()),
  close: () => runWallet(async () => wallet.closeSubmission()),
});
const wallet = createWalletConnection(access, {
  account: selectedAccount, snapshots: () => get<HTMLTextAreaElement>('wc-snapshots').value || '[]',
  canSubmit: (chainId) => __EVM_RPC_ENDPOINTS__.some((endpoint) => `eip155:${endpoint.chainId}` === chainId)
    || __SOLANA_RPC_ENDPOINTS__.some((endpoint) => accountChain('solana', endpoint.network) === chainId),
  clear() {
    requestPending = false;
    if (get('wc-submission-pane').hidden) requestDialog.close();
    wcReview.replaceChildren(); wcApprove.hidden = wcReject.hidden = true; get('wc-sign-form').hidden = true;
    wcPin.value = ''; wcSign.disabled = true; wcSignable = wcRpcBusy = false;
    wcRpcPane.hidden = true; wcRpcRead.disabled = wcRpcCancel.disabled = true; wcRpcEndpoints = [];
  },
  status(text) {
    wcStatus.textContent = __WALLETCONNECT__ ? text : '当前为离线构建，WalletConnect 需要联网构建。';
    get('wc-connection-status').textContent = wcStatus.textContent;
  },
  proposal(proposal, namespaces) {
    requestPending = true; showRequest();
    activeDapp = proposal.proposer.metadata.name;
    wcReview.replaceChildren(); row('dApp（对方声明）', proposal.proposer.metadata.name); row('来源（对方声明）', proposal.proposer.metadata.url);
    row('授权账户', selectedAccount()?.address ?? ''); row('链与方法', JSON.stringify(namespaces, null, 2));
    if (coin === 'evm') {
      const chains = [...new Set(Object.values(namespaces).flatMap((granted) => granted.chains ?? []))];
      const labels = chains.map((chain) => evmNetworkLabel(evmChainReference(chain))).join('\n');
      row('提案中的网络', labels);
    }
    wcApprove.hidden = wcReject.hidden = false; wcStatus.textContent = '请核对连接提案，再授权当前账户。';
  },
  request(review, method, batch) {
    requestPending = true; showRequest();
    wcReview.replaceChildren(); row('dApp（对方声明）', activeDapp); row('请求方法', method);
    if (walletSendsTransaction(method)) row('请求用途', '本请求将签名并提交交易，可能产生链上执行及费用。硬件签名后需再次核对交易标识，单独批准提交。');
    if (batch) {
      row('批量进度', `第 ${batch.index} / ${batch.total} 笔，已签 ${batch.index - 1} 笔`);
      row('本次批准范围', '仅签署下方这一笔交易。每笔均需重新确认、输入 PIN，并按设备策略触摸。');
      row('整批返回规则', '全部交易完成后按原顺序返回；拒绝、过期或中途失败会废弃整批结果。');
    }
    for (const [label, value] of review.rows) row(label, value);
    wcSignable = review.signable;
    get('wc-sign-form').hidden = !review.signable; wcReject.hidden = false;
    wcStatus.textContent = review.signable ? '逐项核对完整请求后再输入 PIN 签名。' : '当前请求仅供审查，请核对拒签原因。';
    refresh();
  },
  contextRequired(account, method, paramsJson) {
    requestPending = true; showRequest();
    row('dApp（对方声明）', activeDapp); row('请求方法', method); row('请求账户', account.address);
    row('待补充上下文', walletSendsTransaction(method)
      ? '此请求将签名并提交交易。请主动选择 RPC 来源，读取完整交易上下文、费用与执行检查，重新审查后方可签名。EVM 会展示缺失字段的补全，Solana 会解析 ALT 并保留原始消息与 blockhash。'
      : '需要完整交易上下文。Solana ALT 尚未解析或 RPC 来源变化后，需选择来源并主动读取，再重新审查。');
    row('请求原始参数', paramsJson);
    wcReject.hidden = false; wcStatus.textContent = '上下文尚未准备完成，请读取后重新审查。';
  },
  rpc(account, available, busy, signable, checks) {
    requestPending = true; showRequest();
    wcRpcBusy = busy; wcSignable = signable;
    if (!signable || busy) { get('wc-sign-form').hidden = true; wcPin.value = ''; wcSign.disabled = true; }
    wcRpcPane.hidden = !__WALLETCONNECT__ || !available;
    wcReject.hidden = false;
    const previous = wcRpcEndpoint.value;
    wcRpcEndpoints = account.coin === 'evm' ? __EVM_RPC_ENDPOINTS__.filter((endpoint) => endpoint.chainId === account.network)
      : __SOLANA_RPC_ENDPOINTS__.filter((endpoint) => endpoint.network === account.network);
    wcRpcEndpoint.replaceChildren();
    wcRpcEndpoints.forEach((endpoint, index) => {
      const option = document.createElement('option'); option.value = String(index);
      option.textContent = `${endpoint.name} · ${new URL(endpoint.url).origin}`; wcRpcEndpoint.append(option);
    });
    if (Array.from(wcRpcEndpoint.options).some((option) => option.value === previous)) wcRpcEndpoint.value = previous;
    if (!wcRpcEndpoints.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = '当前请求网络未配置 RPC'; wcRpcEndpoint.append(option);
    }
    get('wc-rpc-source').textContent = account.coin === 'evm' ? `来源按已授权请求的 chainId ${account.network} 匹配` : `本次请求的 cluster ${account.network}`;
    wcRpcEndpoint.hidden = get('wc-rpc-label').hidden = account.coin === 'evm';
    if (account.coin === 'evm') get('wc-rpc-source').textContent = wcRpcEndpoints[0]
      ? `${wcRpcEndpoints[0].name} · ${new URL(wcRpcEndpoints[0].url).origin} · chainId ${account.network}` : '当前 chainId 未内置 RPC';
    wcRpcEndpoint.disabled = busy || !wcRpcEndpoints.length;
    wcRpcRead.disabled = busy || !wcRpcEndpoints.length; wcRpcCancel.disabled = !busy;
    if (checks.length > 1) checks.forEach((review, index) => {
      row(`整批 RPC 检查 ${index + 1} / ${checks.length}`, review.signable ? '检查通过，仍需逐笔确认签名' : '当前不可签名，整批签名已阻止');
      if (!review.signable && index > 0) for (const [label, value] of review.rows) row(`第 ${index + 1} 笔 / ${label}`, value);
    });
    refresh();
  },
  submission(record) {
    showWalletSubmission(record);
    submissionBusy = !!record?.busy;
    get('wc-record').hidden = !record;
    requestClose.disabled = !!controller || submissionBusy;
    if (record?.active || record?.busy) showRequest();
    else if (!record && !requestPending) requestDialog.close();
    if (record?.active) wcReject.hidden = false;
  },
});
for (const chain of ['evm', 'bitcoin', 'solana'] as const) apps.set(chain, mountTransactionApp(access, chain));
function selectCoin(next: Coin): void {
  invalidateContext(); coin = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-coin]')) {
    const active = button.dataset.coin === coin; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
  }
  accountNetwork.hidden = coin === 'evm';
  for (const chain of ['evm', 'bitcoin', 'solana'] as const) {
    get(`manual-${chain}`).hidden = chain !== coin;
    if (chain === 'evm') continue;
    const label = get(`${prefix(chain)}-network-label`), control = network(chain);
    if (chain === coin) accountNetwork.append(label, control);
    else get(`manual-${chain}`).prepend(label, control);
  }
  refreshAccount(true);
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-coin]')) button.addEventListener('click', () => selectCoin(button.dataset.coin as Coin));
for (const chain of ['bitcoin', 'solana'] as const) network(chain).addEventListener('input', () => { invalidateContext(); refreshAccount(); });
slot.addEventListener('change', () => { invalidateContext(); refreshAccount(); });
address.addEventListener('change', () => { invalidateContext(); refresh(); });
copy.addEventListener('click', () => { const account = selectedAccount(); if (account) void navigator.clipboard.writeText(account.address).then(() => { copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制地址'; }, 1600); }).catch(() => { status.textContent = '复制失败，可选择当前地址手动复制。'; }); });
function readDevice(selection: Promise<USBDevice>): void {
  invalidateContext(); device = undefined;
  const abort = new AbortController(); controller = abort; refreshAccount(); status.textContent = '正在读取设备账户…';
  void (async () => {
    try {
      const selected = await waitForDeviceSelection(selection, abort.signal);
      if (abort.signal.aborted) throw new Error('设备读取已取消');
      device = selected;
      const found = await useDevice(selected, abort, false, (transport) => discoverOpenPgp(transport, abort.signal));
      if (abort.signal.aborted) throw new Error('设备读取已取消');
      discovery = found; preferredDevice = selected; deviceSerial = selected.serialNumber ?? undefined; connection.textContent = selected.productName ?? 'CanoKey';
      status.textContent = `已读取现有槽位，PIN 剩余 ${found.pw1Retries} 次。`;
    } catch (error) { device = undefined; connection.textContent = discovery ? '设备暂时离线' : '未连接设备'; status.textContent = error instanceof Error ? error.message : '读取失败'; }
    finally { controller = undefined; refreshAccount(); }
  })();
}
connect.addEventListener('click', () => readDevice(navigator.usb.requestDevice({ filters: [{ vendorId: 0x20a0, productId: 0x42d4 }] })));
reconnect.addEventListener('click', () => readDevice(navigator.usb.getDevices().then((devices) => {
  const matches = devices.filter((candidate) => candidate.vendorId === 0x20a0 && candidate.productId === 0x42d4);
  if (matches.length !== 1) throw new Error('请使用连接按钮选择一把 CanoKey'); return matches[0]!;
})));
cancel.addEventListener('click', () => { controller?.abort(); });
function runWallet(operation: () => Promise<void>): void {
  void operation().catch((error) => {
    wcStatus.textContent = error instanceof Error ? error.message : '连接操作失败';
    get('wc-connection-status').textContent = wcStatus.textContent;
  }).finally(refresh);
}
async function closeRequest(): Promise<void> {
  if (controller || submissionBusy) return;
  if (requestPending) await wallet.reject();
  requestDialog.close();
}
requestClose.addEventListener('click', () => runWallet(closeRequest));
requestDialog.addEventListener('cancel', (event) => { event.preventDefault(); runWallet(closeRequest); });
get('wc-record').addEventListener('click', showRequest);
connectionDialog = mountWalletPairing(async (uri) => {
  await wallet.pair(uri);
}, () => wallet.invalidate());
get('wc-open').addEventListener('click', () => { if (coin !== 'bitcoin' && __WALLETCONNECT__) connectionDialog?.open(); });
get('wc-disconnect').addEventListener('click', () => wallet.invalidate());
wcApprove.addEventListener('click', () => { wcApprove.disabled = true; runWallet(async () => { try { await wallet.approve(); } finally { wcApprove.disabled = false; } }); });
wcReject.addEventListener('click', () => runWallet(() => wallet.reject()));
wcRpcRead.addEventListener('click', () => {
  const endpoint = wcRpcEndpoint.value ? wcRpcEndpoints[Number(wcRpcEndpoint.value)] : undefined;
  if (endpoint && !wcRpcBusy) runWallet(() => wallet.readRpc(endpoint));
});
wcRpcCancel.addEventListener('click', () => runWallet(() => wallet.reject()));
wcRpcEndpoint.addEventListener('change', () => wallet.changeRpcSource());
wcSign.addEventListener('click', () => {
  if (controller || wcRpcBusy || !wcSignable) return;
  const pin = new TextEncoder().encode(wcPin.value); wcPin.value = '';
  if (pin.length < 6 || pin.length > 64) { pin.fill(0); wcStatus.textContent = '用户 PIN 需要 6–64 字节'; return; }
  wcSign.disabled = true; runWallet(() => wallet.sign(pin));
});
get('wc-snapshots').addEventListener('input', () => wallet.invalidate());
get('device-wait-cancel').addEventListener('click', () => controller?.abort());
deviceWait.addEventListener('cancel', (event) => { event.preventDefault(); controller?.abort(); });
get('device-wait-select').addEventListener('click', () => {
  const current = controller;
  void navigator.usb.requestDevice({ filters: [{ vendorId: 0x20a0, productId: 0x42d4 }] }).then((selected) => {
    if (controller !== current || !deviceWait.open) return;
    if (deviceSerial && selected.serialNumber !== deviceSerial) get('device-wait-status').textContent = '请选择先前读取的 CanoKey。';
    else preferredDevice = selected;
  }).catch(() => { if (controller === current && deviceWait.open) get('device-wait-status').textContent = '设备选择未完成，可以继续等待或取消。'; });
});
if ('usb' in navigator) {
  navigator.usb.addEventListener('disconnect', (event) => {
    if (event.device !== device) return;
    if (!signingTask || signingStarted) controller?.abort();
    device = undefined; requiresReinsert = false;
    connection.textContent = '设备暂时离线';
    status.textContent = discovery ? '' : '请连接并读取 CanoKey。';
    refresh();
  });
  navigator.usb.addEventListener('connect', (event) => {
    if (!discovery || event.device.vendorId !== 0x20a0 || event.device.productId !== 0x42d4
      || (deviceSerial && event.device.serialNumber !== deviceSerial)) return;
    device = event.device; requiresReinsert = false;
    connection.textContent = '设备已接入';
    status.textContent = '已检测到设备，签名前将重新核对槽位公钥。'; refresh();
  });
}
window.addEventListener('pagehide', () => invalidateContext());
selectCoin('evm');
if (!available) status.textContent = '请在支持 WebUSB 的桌面 Chromium 中，通过 localhost 或 HTTPS 打开。';

if (!__WALLETCONNECT__) { get<HTMLButtonElement>('wc-open').disabled = true; wcStatus.textContent = '当前为离线构建，WalletConnect 需要联网构建。'; }
