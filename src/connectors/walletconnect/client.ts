import type SignClient from '@walletconnect/sign-client';
import type { ProposalTypes, SessionTypes, SignClientTypes } from '@walletconnect/types';
import { base58, base64 } from '@scure/base';
import type { WalletAccount } from '../../ui/accounts';
import { sessionNamespaces, reviewWalletRequest, reviewWalletBatchRequest, accountForWalletRequest, walletTransactionSources, walletSendsTransaction } from './policy';
import { executeReviewedTransaction } from '../../signing/execute';
import type { DeviceAccess } from '../../signing/execute';
import { strictJson } from '../../signing/json';
import { MissingSolanaLookupError } from '../../chains/solana/codec';
import type { EvmRpcEndpoint, SolanaRpcEndpoint } from '../../network/config';
import type { BroadcastTask, BroadcastResult } from '../../network/broadcast';
import { solanaSendOptions } from '../../chains/solana/send-options';

type Request = SignClientTypes.EventArguments['session_request'];
type WalletReview = ReturnType<typeof reviewWalletRequest>;
export interface WalletSubmission {
  readonly task: BroadcastTask;
  readonly dapp: string;
  readonly requestId: number;
  readonly attempted: boolean;
  readonly active: boolean;
  readonly busy: boolean;
  readonly result?: BroadcastResult;
}
interface Hooks {
  account(): WalletAccount | undefined;
  proposal(proposal: ProposalTypes.Struct, namespaces: SessionTypes.Namespaces): void;
  request(review: WalletReview, method: string, batch?: { index: number; total: number }): void;
  status(text: string): void;
  clear(): void;
  snapshots(): string;
  contextRequired?(account: WalletAccount, method: string, paramsJson: string): void;
  rpc?(account: WalletAccount, available: boolean, busy: boolean, signable: boolean, checks: readonly WalletReview[]): void;
  submission?(record: WalletSubmission | undefined): void;
  canSubmit?(chainId: string): boolean;
}
type ClientOptions = Parameters<typeof SignClient.init>[0];
export const WALLETCONNECT_PROJECT_ID = 'd2a8b6044c46a77b4de519960103175c';

async function initializeClient(options: ClientOptions): Promise<SignClient> {
  const imported = __WALLETCONNECT__ ? await import('@walletconnect/sign-client') : undefined;
  if (!imported) throw new Error('离线构建不加载连接 SDK');
  return imported.default.init(options);
}

export function createWalletConnection(access: DeviceAccess, hooks: Hooks, loadClient = initializeClient) {
  let client: SignClient | undefined;
  let starting = false;
  let approving = false;
  let pairingTopic: string | undefined;
  let pairing = false;
  let proposal: ProposalTypes.Struct | undefined;
  let namespaces: SessionTypes.Namespaces | undefined;
  let session: SessionTypes.Struct | undefined;
  let bound: WalletAccount | undefined;
  type Pending = { event: Request; account: WalletAccount; method: string; paramsJson: string; reviews: readonly WalletReview[]; ready: boolean; checked: boolean; index: number; outputs: string[]; deadline: number; endpoint?: EvmRpcEndpoint | SolanaRpcEndpoint; task?: BroadcastTask };
  let pending: Pending | undefined;
  let generation = 0;
  let signing = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let rpcController: AbortController | undefined;
  let submissionController: AbortController | undefined;
  let submission: { task: BroadcastTask; dapp: string; requestId: number; attempted: boolean; result?: BroadcastResult } | undefined;
  const seen = new Set<string>();
  const reason = { code: 6000, message: '账户或会话已改变' };
  const now = () => Math.floor(Date.now() / 1000);
  function submissionData(task: BroadcastTask, state: string) {
    return task.chain === 'evm' ? { transactionHash: task.id, state } : { signature: task.id, state };
  }
  async function respondError(event: Request, message: string, code = 4001, data?: ReturnType<typeof submissionData>) {
    await client?.respond({ topic: event.topic, response: { id: event.id, jsonrpc: '2.0', error: { code, message, ...(data ? { data: JSON.stringify(data) } : {}) } } });
  }
  function showSubmission(): void {
    hooks.submission?.(submission ? Object.freeze({ ...submission, active: pending?.task === submission.task, busy: !!submissionController }) : undefined);
  }
  async function rejectPending(message: string) {
    rpcController?.abort(); rpcController = undefined;
    submissionController?.abort();
    const captured = pending; pending = undefined; clearTimeout(expiryTimer); hooks.clear();
    showSubmission();
    if (captured) { captured.outputs.length = 0; await respondError(captured.event, message, 4001,
      captured.task ? submissionData(captured.task, submission?.result?.state ?? (submission?.attempted ? 'unknown' : 'not-sent')) : undefined).catch(() => undefined); }
  }
  function canReadRpc(request: Pending): boolean {
    return !request.task && request.index === 0 && !request.outputs.length && ['eth_signTransaction', 'eth_sendTransaction', 'solana_signTransaction', 'solana_signAllTransactions', 'solana_signAndSendTransaction'].includes(request.method);
  }
  function showPending(): void {
    const captured = pending;
    if (!captured) return;
    hooks.clear();
    if (captured.task) { showSubmission(); return; }
    const review = captured.reviews[captured.index];
    if (review) hooks.request(review, captured.method, captured.method === 'solana_signAllTransactions'
      ? { index: captured.index + 1, total: captured.reviews.length } : undefined);
    else hooks.contextRequired?.(captured.account, captured.method, captured.paramsJson);
    hooks.rpc?.(captured.account, canReadRpc(captured), !!rpcController, captured.ready && !!review?.signable, captured.checked ? captured.reviews : []);
  }
  function scheduleExpiry(): void {
    clearTimeout(expiryTimer);
    const captured = pending;
    if (!captured) return;
    expiryTimer = setTimeout(() => {
      if (pending !== captured) return;
      if (signing) access.cancel();
      void rejectPending('请求或 RPC 上下文已过期'); hooks.status('请求或 RPC 上下文已过期，请重新发起。');
    }, Math.max(0, Math.min(300000, (captured.deadline - now()) * 1000)));
  }
  function invalidate() {
    const hadConnection = starting || approving || pairing || !!proposal || !!session;
    generation++;
    pairing = false;
    const oldPairing = pairingTopic; pairingTopic = undefined;
    if (oldPairing) void client?.core.pairing.disconnect({ topic: oldPairing }).catch(() => undefined);
    if (signing) access.cancel();
    bound = undefined;
    const oldSession = session; session = undefined;
    const oldProposal = proposal; proposal = undefined; namespaces = undefined;
    void rejectPending('请求已取消');
    if (oldProposal) void client?.reject({ id: oldProposal.id, reason }).catch(() => undefined);
    if (oldSession) void client?.disconnect({ topic: oldSession.topic, reason }).catch(() => undefined);
    hooks.status(hadConnection ? '连接已断开，请重新配对并授权。'
      : hooks.account() ? '当前账户已就绪，填写连接信息开始配对。' : '先选择币种与签名账户。');
  }
  async function pair(uri: string) {
    if (!__WALLETCONNECT__) throw new Error('当前为离线构建，请使用联网构建连接 WalletConnect');
    const account = hooks.account();
    if (!account || access.busy()) throw new Error('请先连接设备并选择账户');
    if (account.coin === 'bitcoin') throw new Error('Bitcoin 仅提供手动签名');
    if (!/^wc:[0-9a-f]{64}@2\?/.test(uri) || uri.length > 2048) throw new Error('请输入有效的 WalletConnect v2 URI');
    const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
    if (!/^[0-9a-f]{64}$/.test(params.get('symKey') ?? '') || params.get('relay-protocol') !== 'irn') throw new Error('WalletConnect URI 参数无效');
    if (starting || approving || pairing || proposal || session) throw new Error('已有连接或配对正在进行，请先断开');
    const revision = generation;
    starting = true;
    try {
      if (!client) {
        const initialized = await loadClient({ projectId: WALLETCONNECT_PROJECT_ID, relayUrl: 'wss://relay.walletconnect.org', telemetryEnabled: false,
          metadata: { name: 'CanoKeySigner', description: 'CanoKey transaction signer', url: window.location.origin, icons: [] }, logger: 'silent' });
        client = initialized;
        // Restored sessions cannot inherit a fresh page's hardware account authorization.
        for (const existing of client.session.getAll()) await client.disconnect({ topic: existing.topic, reason });
        client.on('session_proposal', (event) => {
          void (async () => {
            try {
              if (!pairing || !bound || proposal || session || event.params.pairingTopic !== pairingTopic || event.params.expiryTimestamp <= now()) throw new Error('此配对已失效');
              const granted = sessionNamespaces(event.params, bound, hooks.canSubmit);
              proposal = event.params; namespaces = granted; pairing = false;
              hooks.proposal(proposal, granted);
            } catch (error) {
              await client!.reject({ id: event.id, reason: { code: 5100, message: error instanceof Error ? error.message : '不支持的提案' } });
              pairing = false; hooks.status('提案已拒绝，请检查所需链与方法。');
            }
          })().catch(() => hooks.status('提案处理失败，请重新连接。'));
        });
        client.on('session_request', (event) => {
          void (async () => {
            if (!Number.isSafeInteger(event.id) || event.id < 0) return;
            const key = `${event.topic}:${event.id}`;
            if (seen.has(key)) return;
            if (seen.size >= 1024) { await respondError(event, '会话请求上限已到，请重新连接'); return; }
            seen.add(key);
            const active = session;
            const account = bound;
            const deadline = Math.min(active?.expiry ?? 0, event.params.request.expiryTimestamp ?? now() + 300, now() + 300);
            try {
              if (!active || !account || event.topic !== active.topic || (!Number.isFinite(deadline) || deadline <= now())) throw new Error('请求不属于当前授权会话');
              const requestAccount = accountForWalletRequest(account, active.namespaces, event.params.chainId, event.params.request.method);
              if (pending || signing || submissionController) throw new Error('请等待上一笔交易处理完成');
              const method = event.params.request.method;
              if (walletSendsTransaction(method) && submission) throw new Error('请先查询或保存并结束上次提交记录');
              if (method === 'solana_getAccounts') {
                await client!.respond({ topic: event.topic, response: { id: event.id, jsonrpc: '2.0', result: [{ pubkey: account.address }] } });
                return;
              }
              const paramsJson = JSON.stringify(event.params.request.params);
              if (typeof paramsJson !== 'string') throw new Error('请求参数无效');
              const params = strictJson(paramsJson);
              let reviews: readonly WalletReview[];
              try {
                if (walletSendsTransaction(method)) {
                  walletTransactionSources(requestAccount, method, params);
                  reviews = [];
                } else reviews = method === 'solana_signAllTransactions'
                  ? reviewWalletBatchRequest(requestAccount, params, hooks.snapshots())
                  : [reviewWalletRequest(requestAccount, method, params, hooks.snapshots())];
              } catch (error) {
                if (!(error instanceof MissingSolanaLookupError) || !hooks.contextRequired) throw error;
                reviews = [];
              }
              if (reviews.some((review) => !review.signable)) throw new Error('当前交易不满足签名策略');
              pending = { event: { ...event }, account: Object.freeze({ ...requestAccount }), method, paramsJson, reviews,
                ready: reviews.length > 0, checked: false, index: 0, outputs: [], deadline };
              scheduleExpiry(); showPending();
            } catch (error) { await respondError(event, error instanceof Error ? error.message : '请求参数无效', -32602); }
          })().catch(() => hooks.status('请求处理失败，请断开连接。'));
        });
        const deleted = (event: { topic: string }) => { if (event.topic === session?.topic) invalidate(); };
        client.on('session_update', (event) => { if (event.topic === session?.topic) invalidate(); });
        client.on('session_delete', deleted); client.on('session_expire', deleted);
        client.on('session_request_expire', (event) => { if (pending?.event.id === event.id) { if (signing) access.cancel(); void rejectPending('请求已过期'); } });
        client.on('proposal_expire', (event) => { if (proposal?.id === event.id) { proposal = undefined; namespaces = undefined; hooks.clear(); hooks.status('连接提案已过期'); } });
      }
      if (revision !== generation) throw new Error('账户已改变，请重新配对');
      bound = Object.freeze({ ...account, slot: Object.freeze({ ...account.slot }) });
      pairingTopic = uri.slice(3, uri.indexOf('@'));
      pairing = true;
      await client.pair({ uri });
      if (revision !== generation) throw new Error('配对已取消');
      if (pairing) hooks.status('已提交配对，等待 dApp 连接提案。');
    } catch (error) { pairing = false; throw error; }
    finally { starting = false; }
  }
  async function approve() {
    if (!client || !proposal || !namespaces || !bound || approving || proposal.expiryTimestamp <= now()) throw new Error('提案已失效');
    const revision = generation;
    const selectedProposal = proposal;
    const selectedNamespaces = namespaces;
    proposal = undefined; namespaces = undefined; approving = true;
    try {
      const approved = await client.approve({ id: selectedProposal.id, namespaces: selectedNamespaces });
      const established = await approved.acknowledged();
      if (revision !== generation) { await client.disconnect({ topic: established.topic, reason }); return; }
      session = established; pairing = false; seen.clear(); hooks.clear();
      hooks.status(`已连接 ${session.peer.metadata.name}，等待逐笔交易请求。`);
    } catch (error) {
      if (revision === generation) invalidate();
      throw error;
    } finally { approving = false; }
  }
  async function sign(pin: Uint8Array) {
    const captured = pending, account = bound;
    if (!captured || !account || signing || rpcController || captured.task || captured.deadline <= now()
      || !captured.ready || !captured.reviews[captured.index]?.signable) { pin.fill(0); throw new Error('请求已失效或尚未完成可签名审查'); }
    const revision = generation;
    const review = captured.reviews[captured.index]!;
    const batch = captured.method === 'solana_signAllTransactions';
    signing = true;
    try {
      const result = await executeReviewedTransaction(access, review, account.slot, pin);
      if (revision !== generation || pending !== captured || captured.deadline <= now()) throw new Error('请求已取消或过期，结果已作废');
      if (__WALLETCONNECT__ && walletSendsTransaction(captured.method)) {
        if ('kind' in review || !captured.checked || !captured.endpoint) throw new Error('提交请求缺少已核对的 RPC 来源');
        const { prepareBroadcast } = await import('../../network/broadcast');
        if (revision !== generation || pending !== captured || captured.deadline <= now()) throw new Error('提交请求已取消或过期');
        const options = review.chain === 'solana' ? solanaSendOptions((strictJson(captured.paramsJson) as Record<string, unknown>).sendOptions) : undefined;
        const task = prepareBroadcast(review, result.output, captured.endpoint, options);
        captured.task = task; captured.ready = false;
        submission = { task, dapp: session!.peer.metadata.name, requestId: captured.event.id, attempted: false }; showPending();
        hooks.status('签名已验证。请再次核对交易标识与来源，单独批准提交后才会向 dApp 返回交易标识。');
        if (!result.authenticationCleared) access.requireReinsert();
        return;
      }
      let response: unknown = result.output;
      if (batch) {
        if (!result.authenticationCleared) throw new Error('设备认证状态未退出，批量请求已终止，请重新插入设备');
        captured.outputs.push(result.output);
        captured.index++;
        if (captured.index < captured.reviews.length) {
          showPending();
          return;
        }
        response = { transactions: [...captured.outputs] };
      } else if (review.chain === 'solana') {
        if ('kind' in review) response = { signature: base58.encode(base64.decode(result.output)) };
        else {
          const start = review.signatureOffset + review.signerIndex * 64;
          response = { transaction: result.output, signature: base58.encode(base64.decode(result.output).slice(start, start + 64)) };
        }
      }
      await client!.respond({ topic: captured.event.topic, response: { id: captured.event.id, jsonrpc: '2.0', result: response } });
      if (revision !== generation || pending !== captured) return;
      captured.outputs.length = 0;
      pending = undefined; clearTimeout(expiryTimer); hooks.clear(); hooks.status('签名已验证，结果已返回 dApp。');
      if (!result.authenticationCleared) access.requireReinsert();
    } catch (error) {
      if (pending === captured) access.requireReinsert();
      if (pending === captured) await rejectPending('签名失败或已取消');
      throw error;
    } finally { pin.fill(0); signing = false; }
  }
  async function readRpc(endpoint: EvmRpcEndpoint | SolanaRpcEndpoint, fetcher: typeof fetch = fetch) {
    const captured = pending;
    if (!__WALLETCONNECT__ || !captured || !bound || signing || rpcController || !canReadRpc(captured)
      || captured.deadline <= now() || access.busy()) throw new Error('当前请求无法读取 RPC 上下文');
    const revision = generation, abort = new AbortController(), selected = Object.freeze({ ...endpoint });
    rpcController = abort;
    // Once an RPC read starts, an old offline review cannot be used as a fallback.
    captured.reviews = [];
    captured.ready = false; captured.checked = false;
    hooks.clear(); hooks.rpc?.(captured.account, true, true, false, []);
    hooks.status('正在为当前请求读取 RPC 上下文，完成后需重新审查并确认。');
    try {
      const { readWalletRpcRequest } = await import('./rpc');
      if (pending !== captured || abort.signal.aborted) throw new Error('RPC 请求已取消');
      const result = await readWalletRpcRequest(captured.account, captured.method, strictJson(captured.paramsJson), selected, abort.signal, fetcher);
      if (revision !== generation || pending !== captured || abort.signal.aborted || captured.deadline <= now()) throw new Error('RPC 请求已取消或过期');
      captured.reviews = result.reviews;
      captured.ready = result.reviews.every((review) => review.signable);
      captured.checked = true;
      captured.endpoint = selected;
      captured.deadline = Math.min(captured.deadline, Math.floor(result.expiresAt / 1000));
      rpcController = undefined; scheduleExpiry(); showPending();
      if (result.reviews.some((review) => !review.signable)) hooks.status('RPC 检查未通过，当前请求仅供审查，请核对结果并拒绝或重新读取。');
    } catch (error) {
      if (pending === captured) await rejectPending('RPC 上下文读取失败或已取消');
      throw error;
    } finally { if (rpcController === abort) rpcController = undefined; }
  }
  async function submit(fetcher: typeof fetch = fetch) {
    const captured = pending, record = submission;
    if (!__WALLETCONNECT__ || !captured || !record || captured.task !== record.task || record.attempted || signing || rpcController || submissionController
      || captured.deadline <= now()) throw new Error('当前请求无法提交');
    const revision = generation, abort = new AbortController();
    submissionController = abort; record.attempted = true; showSubmission();
    try {
      const { submitBroadcast } = await import('../../network/broadcast');
      // The same signal also cancels a write if the session changes during submission.
      const result = await submitBroadcast(record.task, abort.signal, fetcher);
      record.result = Object.freeze(result); showSubmission();
      if (revision !== generation || pending !== captured) return;
      if (captured.deadline <= now()) { await rejectPending('提交期间请求已过期'); return; }
      pending = undefined; clearTimeout(expiryTimer); hooks.clear(); showSubmission();
      if (result.state === 'unknown' || result.state === 'not-sent') {
        await respondError(captured.event, `${result.message} 交易标识 ${record.task.id}`, -32000, submissionData(record.task, result.state));
      } else {
        const response = record.task.chain === 'solana' ? { signature: record.task.id } : record.task.id;
        await client!.respond({ topic: captured.event.topic, response: { id: captured.event.id, jsonrpc: '2.0', result: response } });
      }
      hooks.status(`${result.message} 请求处理结果已返回 dApp，可继续查询本次交易。`);
    } catch (error) {
      if (pending === captured) await rejectPending(`提交未完成，交易标识 ${record.task.id}`);
      throw error;
    } finally { if (submissionController === abort) submissionController = undefined; showSubmission(); }
  }
  async function querySubmission(fetcher: typeof fetch = fetch) {
    const record = submission;
    if (!__WALLETCONNECT__ || !record || submissionController) throw new Error('当前没有可查询的提交记录');
    const abort = new AbortController(); submissionController = abort; showSubmission();
    try {
      const { queryBroadcast } = await import('../../network/broadcast');
      record.result = Object.freeze(await queryBroadcast(record.task, abort.signal, fetcher));
    } finally { if (submissionController === abort) submissionController = undefined; showSubmission(); }
  }
  return { pair, approve, sign, invalidate, readRpc, submit, querySubmission,
    closeSubmission() {
      if (submissionController || (submission && pending?.task === submission.task)) throw new Error('请先完成或拒绝当前提交请求');
      submission = undefined; showSubmission();
    },
    changeRpcSource() {
      if (!pending || !canReadRpc(pending) || signing || rpcController) return;
      pending.reviews = []; pending.ready = pending.checked = false; showPending();
      hooks.status('RPC 来源已变化，旧审查已失效，请为当前请求重新读取。');
    },
    async reject() {
      if (approving) { invalidate(); return; }
      if (signing) access.cancel();
      if (proposal && client) await client.reject({ id: proposal.id, reason: { code: 5000, message: '用户拒绝连接' } });
      proposal = undefined; namespaces = undefined;
      await rejectPending('用户拒绝签名'); hooks.clear(); hooks.status('请求已拒绝。');
    },
  };
}
