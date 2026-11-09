import type { WalletSubmission } from '../connectors/walletconnect/client';

export function mountWalletSubmission(actions: { submit(): void; query(): void; close(): void }) {
  const get = <T extends HTMLElement>(name: string) => document.getElementById(`wc-submission-${name}`) as T;
  const pane = get('pane'), report = get('review'), status = get('status');
  const confirm = get<HTMLInputElement>('confirm'), send = get<HTMLButtonElement>('send');
  const query = get<HTMLButtonElement>('query'), close = get<HTMLButtonElement>('close'), save = get<HTMLButtonElement>('save');
  let record: WalletSubmission | undefined;
  function refresh(): void {
    const available = !!record?.active && !record.attempted && !record.busy;
    confirm.disabled = !available; send.disabled = !available || !confirm.checked;
    query.disabled = !record || record.busy; close.disabled = !record || record.busy || record.active;
    save.disabled = !record;
  }
  confirm.addEventListener('change', refresh);
  send.addEventListener('click', () => { if (!send.disabled && confirm.checked) actions.submit(); });
  query.addEventListener('click', () => { if (!query.disabled) actions.query(); });
  close.addEventListener('click', () => { if (!close.disabled) actions.close(); });
  save.addEventListener('click', () => {
    if (!record) return;
    const value = { chain: record.task.chain, network: record.task.network, transactionId: record.task.id, source: record.task.source,
      dapp: record.dapp, requestId: record.requestId, state: record.result?.state ?? (record.attempted ? 'unknown' : 'prepared'),
      message: record.result?.message ?? '签名交易已准备，提交情况以当前记录为准。', recordedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'walletconnect-submission-status.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return (next: WalletSubmission | undefined): void => {
    record = next; pane.hidden = !record; confirm.checked = false; report.replaceChildren();
    if (record) {
      const rows: readonly (readonly [string, string])[] = [['dApp（对方声明）', record.dapp], ['WalletConnect 请求 ID', String(record.requestId)], ...record.task.rows];
      for (const [label, value] of rows) {
        const term = document.createElement('dt'), detail = document.createElement('dd');
        term.textContent = label; detail.textContent = value; report.append(term, detail);
      }
      status.textContent = record.busy ? '正在处理本次提交或查询，请等待结果。'
        : record.result?.message ?? (record.attempted ? '提交结果尚未核实，请按本次交易标识查询。'
          : record.active ? '签名已验证，请单独批准提交。可通过拒绝请求取消本次提交。' : '请求已经结束，保留交易标识供状态查询或下载。');
    }
    refresh();
  };
}
