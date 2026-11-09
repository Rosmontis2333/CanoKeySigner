import type { EvmReview } from '../chains/evm/transaction';
import type { SolanaReview } from '../chains/solana/transaction';
import type { BroadcastTask, BroadcastResult } from '../network/broadcast';
import type { EvmRpcEndpoint, SolanaRpcEndpoint } from '../network/config';

export function mountBroadcastApp(chain: 'evm' | 'solana') {
  const prefix = chain === 'evm' ? 'transaction' : 'solana';
  const get = <T extends HTMLElement>(name: string) => document.getElementById(`${prefix}-broadcast-${name}`) as T;
  const pane = get('pane'), prepare = get<HTMLButtonElement>('prepare'), source = get<HTMLSelectElement>('source');
  const confirm = get<HTMLInputElement>('confirm'), send = get<HTMLButtonElement>('send'), query = get<HTMLButtonElement>('query');
  const close = get<HTMLButtonElement>('close'), save = get<HTMLButtonElement>('save'), report = get('review'), status = get('status');
  let candidate: { review: EvmReview | SolanaReview; output: string } | undefined;
  let endpoints: readonly (EvmRpcEndpoint | SolanaRpcEndpoint)[] = [];
  let task: BroadcastTask | undefined, result: BroadcastResult | undefined;
  let attempted = false, preparing = false;
  let controller: AbortController | undefined;
  let generation = 0;
  function refresh(): void {
    const busy = !!controller || preparing;
    prepare.disabled = busy;
    source.disabled = busy || attempted || !endpoints.length;
    confirm.disabled = busy || attempted || !task;
    send.disabled = busy || attempted || !task || !confirm.checked;
    query.disabled = busy || !task; save.disabled = !task; close.disabled = busy;
  }
  function clear(): void {
    generation++; task = undefined; result = undefined; attempted = false;
    pane.hidden = true; report.replaceChildren(); confirm.checked = false; refresh();
  }
  function showResult(value: BroadcastResult): void {
    result = value; status.textContent = `${value.message} 本次交易标识 ${task!.id}`;
  }
  async function prepareTask(): Promise<void> {
    if (!__WALLETCONNECT__ || !candidate || preparing || controller) return;
    if (attempted) { status.textContent = '当前保留上次提交记录。可查询或下载记录，结束本次记录后再准备下一笔。'; return; }
    const captured = candidate, revision = ++generation;
    preparing = true; refresh();
    try {
      const { prepareBroadcast } = await import('../network/broadcast');
      if (revision !== generation || candidate !== captured) return;
      const endpoint = source.value ? endpoints[Number(source.value)] : undefined;
      if (!endpoint) throw new Error('当前交易网络未配置广播 RPC 来源');
      task = prepareBroadcast(captured.review, captured.output, endpoint); result = undefined;
      report.replaceChildren();
      for (const [label, value] of task.rows) {
        const term = document.createElement('dt'), detail = document.createElement('dd');
        term.textContent = label; detail.textContent = value; report.append(term, detail);
      }
      status.textContent = '请核对来源、交易标识与全部签名内容，再单独批准提交。';
    } catch (error) {
      if (revision === generation) { task = undefined; report.replaceChildren(); status.textContent = error instanceof Error ? error.message : '准备广播失败'; }
    } finally { preparing = false; confirm.checked = false; refresh(); }
  }
  prepare.addEventListener('click', () => {
    if (!__WALLETCONNECT__ || !candidate || attempted || preparing || controller) {
      if (attempted) status.textContent = '当前保留上次提交记录，请先查询或保存并结束记录。';
      return;
    }
    const review = candidate.review;
    endpoints = review.chain === 'evm' ? __EVM_RPC_ENDPOINTS__.filter((endpoint) => endpoint.chainId === review.chainId)
      : __SOLANA_RPC_ENDPOINTS__.filter((endpoint) => endpoint.network === review.network);
    source.replaceChildren();
    endpoints.forEach((endpoint, index) => {
      const option = document.createElement('option'); option.value = String(index);
      option.textContent = `${endpoint.name} · ${new URL(endpoint.url).origin}`; source.append(option);
    });
    pane.hidden = false; void prepareTask();
  });
  source.addEventListener('change', () => { task = undefined; confirm.checked = false; void prepareTask(); });
  confirm.addEventListener('change', refresh);
  async function run(submit: boolean): Promise<void> {
    if (!__WALLETCONNECT__ || !task || controller || preparing || (submit && (attempted || !confirm.checked))) return;
    const captured = task, abort = new AbortController(); controller = abort;
    if (submit) attempted = true;
    confirm.checked = false; status.textContent = submit ? '正在查询既有状态、重新检查上下文并提交…' : '正在查询本次交易的状态…'; refresh();
    try {
      const module = await import('../network/broadcast');
      const value = submit ? await module.submitBroadcast(captured, abort.signal) : await module.queryBroadcast(captured, abort.signal);
      if (task === captured) showResult(value);
    } catch (error) {
      if (task === captured) status.textContent = `${error instanceof Error ? error.message : '查询失败'} 本次交易标识 ${captured.id}`;
    } finally { if (controller === abort) controller = undefined; refresh(); }
  }
  send.addEventListener('click', () => { void run(true); });
  query.addEventListener('click', () => { void run(false); });
  close.addEventListener('click', clear);
  save.addEventListener('click', () => {
    if (!task) return;
    const value = { chain: task.chain, network: task.network, transactionId: task.id, source: task.source,
      state: result?.state ?? (attempted ? 'unknown' : 'prepared'), message: result?.message ?? status.textContent, observedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${chain}-submission-status.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  prepare.hidden = true; refresh();
  return {
    setResult(review: EvmReview | SolanaReview, output: string) {
      candidate = { review, output }; prepare.hidden = !__WALLETCONNECT__; refresh();
    },
    invalidate() {
      candidate = undefined; prepare.hidden = true; controller?.abort(); generation++;
      if (!attempted) clear();
      else { confirm.checked = false; refresh(); }
    },
  };
}
