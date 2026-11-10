import { prepareSolanaTransaction } from '../chains/solana/transaction';
import { base58, base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p2wpkh, NETWORK, TEST_NETWORK } from '@scure/btc-signer';
import { finalizeBitcoinTransaction, prepareBitcoinTransaction } from '../chains/bitcoin/transaction';
import { addr } from 'micro-eth-signer';
import { prepareEvmTransaction, evmTransactionChainId } from '../chains/evm/transaction';
import { prepareEvmMessage } from '../chains/evm/message';
import { executeReviewedTransaction } from '../signing/execute';
import type { DeviceAccess, Review } from '../signing/execute';
import { prepareSolanaMessage, prepareSolanaTextMessage } from '../chains/solana/message';
import { mountBroadcastApp } from './broadcast';
import { detectEvmInput, detectBitcoinInput, detectAutomaticSolanaInput, decodeSigningFile } from './signing-input';

export function mountTransactionApp(access: DeviceAccess, chain: 'evm' | 'bitcoin' | 'solana'): { invalidate(): void; refresh(): void } {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(chain === 'evm' ? id : id.replace('transaction-', chain + '-')) as T;
  const source = get<HTMLTextAreaElement>('transaction-source');
  const network = chain === 'evm' ? undefined : get<HTMLSelectElement>('transaction-network');
  const outputEncoding = get<HTMLSelectElement>('transaction-output-encoding');
  const snapshots = get<HTMLTextAreaElement>('transaction-snapshots');
  const rpcPane = chain !== 'bitcoin' ? get('transaction-rpc') : undefined;
  const rpcEndpoint = chain !== 'bitcoin' ? get<HTMLSelectElement>('transaction-rpc-endpoint') : undefined;
  const rpcRead = chain !== 'bitcoin' ? get<HTMLButtonElement>('transaction-rpc-read') : undefined;
  const rpcCancel = chain !== 'bitcoin' ? get<HTMLButtonElement>('transaction-rpc-cancel') : undefined;
  const broadcast = chain !== 'bitcoin' ? mountBroadcastApp(chain) : undefined;
  const encodeResult = (bytes: Uint8Array) => outputEncoding.value === 'hex' ? bytesToHex(bytes)
    : outputEncoding.value === 'base58' ? base58.encode(bytes) : base64.encode(bytes);
  let resultIsMessage = false;
  let resultBytes: Uint8Array | undefined;
  let finalizedBytes: Uint8Array | undefined;
  const finalize = get<HTMLButtonElement>('transaction-finalize');
  const slot = get<HTMLSelectElement>('transaction-slot');
  const file = get<HTMLInputElement>('transaction-file');
  const parse = get<HTMLButtonElement>('transaction-parse');
  const pin = get<HTMLInputElement>('transaction-pin');
  const sign = get<HTMLButtonElement>('transaction-sign');
  const output = get<HTMLTextAreaElement>('transaction-result');
  const download = get<HTMLButtonElement>('transaction-download');
  const status = get('transaction-status');
  const reviewRows = get('transaction-review');
  const approvalPane = get('transaction-approval'), resultPane = get('transaction-output');
  let review: Review | undefined;
  let signing = false;
  let generation = 0;
  let fileGeneration = 0;
  let rpcController: AbortController | undefined;
  let rpcExpiry: ReturnType<typeof setTimeout> | undefined;

  function invalidate(): void {
    broadcast?.invalidate();
    generation++;
    clearTimeout(rpcExpiry);
    rpcController?.abort(); rpcController = undefined;
    if (signing) access.cancel();
    review = undefined;
    pin.value = '';
    reviewRows.replaceChildren();
    approvalPane.hidden = true; resultPane.hidden = true;
    resultBytes = undefined;
    finalizedBytes = undefined;
    if (finalize) finalize.disabled = true;
    output.value = '';
    download.disabled = true;
    sign.disabled = true;
  }
  function detectInput() {
    return chain === 'solana' ? detectAutomaticSolanaInput(source.value)
      : chain === 'bitcoin' ? detectBitcoinInput(source.value)
        : { kind: detectEvmInput(source.value), format: 'transaction', source: source.value, encoding: '' };
  }
  function refresh(): void {
    let method = '';
    try { method = detectInput().kind; } catch { /* Incomplete input stays unavailable for RPC. */ }
    if (chain !== 'bitcoin') {
      get('transaction-kind-badge').textContent = method === 'transaction' ? '自动识别 · 交易' : method ? '自动识别 · 消息' : '自动识别';
      if (chain === 'solana') {
        const message = method !== 'transaction';
        snapshots.hidden = get('transaction-snapshots-label').hidden = message;
        outputEncoding.hidden = get('transaction-output-encoding-label').hidden = message;
      }
    }
    const previous = access.selectedSlot?.(chain) ?? slot.value;
    slot.replaceChildren();
    for (const key of access.slots().filter((key) => key.algorithm === (chain === 'solana' ? 'ed25519' : 'secp256k1'))) {
      const option = document.createElement('option');
      option.value = key.slot;
      const publicKey = hexToBytes(key.publicKeyHex);
      const account = chain === 'evm' ? addr.fromPublicKey(publicKey) : chain === 'solana' ? base58.encode(publicKey) : p2wpkh(secp256k1.Point.fromBytes(publicKey).toBytes(true), (network?.value ?? '') === 'mainnet' ? NETWORK : TEST_NETWORK).address;
      option.textContent = `${key.slot} · ${account}`;
      slot.append(option);
    }
    if (Array.from(slot.options).some((item) => item.value === previous)) slot.value = previous;
    parse.disabled = signing || !!rpcController || access.busy() || slot.options.length === 0;
    sign.disabled = signing || access.busy() || !review?.signable;
    pin.disabled = signing || access.busy();
    if (rpcPane && rpcEndpoint && rpcRead) {
      rpcPane.hidden = !__WALLETCONNECT__ || method !== 'transaction';
      const previousEndpoint = rpcEndpoint.value;
      rpcEndpoint.replaceChildren();
      let rpcChainId = '';
      if (chain === 'evm' && method === 'transaction') {
        try { rpcChainId = evmTransactionChainId(source.value); } catch { /* Wait for complete signing content. */ }
      }
      const endpoints = chain === 'evm' ? __EVM_RPC_ENDPOINTS__ : __SOLANA_RPC_ENDPOINTS__;
      endpoints.forEach((endpoint, index) => {
        if ('chainId' in endpoint ? endpoint.chainId !== rpcChainId : endpoint.network !== (network?.value ?? '')) return;
        const option = document.createElement('option'); option.value = String(index);
        option.textContent = `${endpoint.name} · ${new URL(endpoint.url).origin}`; rpcEndpoint.append(option);
      });
      if (Array.from(rpcEndpoint.options).some((option) => option.value === previousEndpoint)) rpcEndpoint.value = previousEndpoint;
      const hasEndpoint = rpcEndpoint.options.length > 0;
      if (!hasEndpoint) {
        const option = document.createElement('option'); option.value = '';
        option.textContent = chain === 'evm' && !rpcChainId ? '导入完整签名内容后匹配 RPC 来源' : '当前网络未配置 RPC'; rpcEndpoint.append(option);
      }
      rpcEndpoint.disabled = !!rpcController || !hasEndpoint;
      rpcRead.disabled = !__WALLETCONNECT__ || signing || !!rpcController || access.busy() || !slot.options.length || !hasEndpoint;
      rpcCancel!.disabled = !rpcController;
    }
  }
  for (const control of [source, ...(network ? [network] : []), slot, ...(snapshots ? [snapshots] : []), ...(rpcEndpoint ? [rpcEndpoint] : [])]) control.addEventListener('input', () => {
    invalidate(); refresh();
  });
  outputEncoding?.addEventListener('change', () => {
    if (resultBytes) output.value = encodeResult(resultBytes);
  });
  for (const control of [source, network, file, snapshots]) {
    if (control) control.addEventListener('change', () => { if (!signing) refresh(); });
  }
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    const request = ++fileGeneration;
    invalidate();
    const revision = generation;
    if (!selected) return;
    const limit = chain === 'bitcoin' ? 2097152 : chain === 'solana' ? 10000 : 262144;
    if (selected.size > limit) { status.textContent = '文件超出当前链的大小限制'; return; }
    const read = async () => {
      if (chain === 'evm') return selected.text();
      return decodeSigningFile(new Uint8Array(await selected.arrayBuffer()), chain);
    };
    void read().then((text) => {
      if (request !== fileGeneration || revision !== generation || signing) return;
      invalidate();
      source.value = text;
      refresh();
      status.textContent = '文件已载入，请解析并审查。';
    }).catch((error) => {
      if (request === fileGeneration && revision === generation) status.textContent = error instanceof Error ? error.message : '读取文件失败';
    });
  });
  function renderReview(selected: Review): void {
    for (const [label, value] of selected.rows) {
      const term = document.createElement('dt'), detail = document.createElement('dd');
      term.textContent = label; detail.textContent = value; reviewRows.append(term, detail);
    }
    approvalPane.hidden = !selected.signable;
    status.textContent = selected.signable ? '请逐项核对完整签名内容、账户、网络和授权效果，再确认签名。' : '只读审查完成，当前交易无法签名。';
  }
  rpcRead?.addEventListener('click', () => {
    let detected;
    try { detected = detectInput(); } catch (error) {
      status.textContent = error instanceof Error ? error.message : '无法识别签名内容'; return;
    }
    if (!__WALLETCONNECT__ || chain === 'bitcoin' || detected.kind !== 'transaction' || access.busy() || signing) return;
    const key = access.slots().find((key) => key.slot === slot.value);
    const endpoints = chain === 'evm' ? __EVM_RPC_ENDPOINTS__ : __SOLANA_RPC_ENDPOINTS__;
    const endpoint = rpcEndpoint!.value ? endpoints[Number(rpcEndpoint!.value)] : undefined;
    if (!key || !endpoint) return;
    invalidate();
    const abort = new AbortController(), revision = generation; rpcController = abort;
    const input = { source: detected.source, publicKeyHex: key.publicKeyHex, network: (network?.value ?? ''), encoding: detected.encoding, format: detected.format };
    status.textContent = '正在核对 RPC 网络、读取上下文并检查原始交易…'; refresh();
    void (async () => {
      try {
        if (revision !== generation || abort.signal.aborted) return;
        const result = 'chainId' in endpoint
          ? await (await import('../network/evm')).readEvmRpcContext(endpoint, input, abort.signal)
          : await (await import('../network/solana')).readSolanaRpcContext(endpoint, input, abort.signal);
        if (revision !== generation || abort.signal.aborted) return;
        review = result.review; renderReview(review);
        const captured = review;
        rpcExpiry = setTimeout(() => {
          if (review !== captured) return;
          invalidate(); status.textContent = 'RPC 上下文已过期，请重新读取并审查。'; refresh();
        }, Math.max(0, result.expiresAt - Date.now()));
      } catch (error) {
        if (revision === generation && !abort.signal.aborted) status.textContent = error instanceof Error ? error.message : 'RPC 读取失败';
      } finally { if (rpcController === abort) { rpcController = undefined; refresh(); } }
    })();
  });
  rpcCancel?.addEventListener('click', () => {
    if (!rpcController) return;
    invalidate(); status.textContent = 'RPC 读取已取消，请重新读取或使用手动审查。'; refresh();
  });
  parse.addEventListener('click', () => {
    invalidate();
    try {
      const key = access.slots().find((key) => key.slot === slot.value);
      if (!key) throw new Error('请先读取 CanoKey 的对应算法槽位');
      const { kind: method, format, encoding, source: content } = detectInput();
      if (chain === 'evm') review = method === 'personal_sign' || method === 'eth_signTypedData_v4'
        ? prepareEvmMessage(method, source.value, key.publicKeyHex) : prepareEvmTransaction(source.value, key.publicKeyHex);
      else if (chain === 'bitcoin') review = prepareBitcoinTransaction(content, key.publicKeyHex, (network?.value ?? ''), encoding);
      else if (method === 'offchain-text') review = prepareSolanaTextMessage(source.value, key.publicKeyHex, (network?.value ?? ''));
      else if (method === 'offchain-import') review = prepareSolanaMessage(content, key.publicKeyHex, (network?.value ?? ''), encoding);
      else review = prepareSolanaTransaction(content, key.publicKeyHex, (network?.value ?? ''), encoding, format, snapshots.value || '[]');
      renderReview(review);
    } catch (error) { status.textContent = error instanceof Error ? error.message : '解析失败'; }
    refresh();
  });
  sign.addEventListener('click', () => {
    if (!review || signing || access.busy()) return;
    const selectedReview = review;
    const key = access.slots().find((key) => key.slot === slot.value);
    if (!key) return;
    const pinBytes = new TextEncoder().encode(pin.value);
    pin.value = '';
    if (pinBytes.length < 6 || pinBytes.length > 64) {
      pinBytes.fill(0); status.textContent = 'PW1 必须为 6–64 字节'; return;
    }
    const revision = generation;
    signing = true;
    status.textContent = '正在核对硬件公钥并签名，请按设备策略触摸确认。';
    refresh();
    void (async () => {
      try {
        const result = await executeReviewedTransaction(access, selectedReview, key, pinBytes);
        if (revision !== generation) throw new Error('审查内容已变化，签名结果已作废');
        if (selectedReview.chain === 'bitcoin') {
          resultBytes = base64.decode(result.output);
          try { finalizedBytes = finalizeBitcoinTransaction(selectedReview, resultBytes); } catch { finalizedBytes = undefined; }
          finalize.disabled = !finalizedBytes;
          output.value = outputEncoding.value === 'hex' ? bytesToHex(resultBytes) : result.output;
        } else if (selectedReview.chain === 'solana') {
          if ('kind' in selectedReview) {
            get('transaction-result-label').textContent = '已验证的离链消息与当前账户签名 JSON';
            output.value = JSON.stringify({ method: 'solana_signMessage', publicKey: base58.encode(hexToBytes(selectedReview.publicKeyHex)),
              messageBase64: base64.encode(hexToBytes(selectedReview.messageHex)), signatureBase58: base58.encode(base64.decode(result.output)) }, null, 2);
          } else {
            get('transaction-result-label').textContent = '部分签名 Solana transaction';
            resultBytes = base64.decode(result.output);
            output.value = encodeResult(resultBytes);
          }
        } else {
          output.value = result.output;
          get('transaction-result-label').textContent = 'kind' in selectedReview ? '已验证的消息签名 Hex（r / s / v）' : '已验证的签名交易 Hex';
        }
        resultIsMessage = 'kind' in selectedReview;
        if (chain === 'solana') download.textContent = resultIsMessage ? '下载消息与签名 JSON' : '下载二进制 transaction';
        resultPane.hidden = false;
        download.disabled = false;
        if (selectedReview.chain !== 'bitcoin' && !('kind' in selectedReview)) broadcast?.setResult(selectedReview, result.output);
        status.textContent = result.authenticationCleared ? '签名及结果复核通过，可以导出。'
          : '签名已验证，认证退出未确认，请拔插设备。';
        if (!result.authenticationCleared) access.requireReinsert();
      } catch (error) {
        output.value = '';
        resultBytes = finalizedBytes = undefined; resultPane.hidden = true;
        if (finalize) finalize.disabled = true;
        download.disabled = true;
        access.requireReinsert();
        status.textContent = error instanceof Error ? error.message : '签名失败';
      } finally {
        pinBytes.fill(0);
        clearTimeout(rpcExpiry);
        review = undefined;
        approvalPane.hidden = true;
        signing = false;
        refresh();
      }
    })();
  });
  finalize?.addEventListener('click', () => {
    if (!finalizedBytes) return;
    const url = URL.createObjectURL(new Blob([bytesToHex(finalizedBytes) + '\n'], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'finalized-bitcoin-transaction.hex'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  download.addEventListener('click', () => {
    if (!output.value) return;
    const content = resultBytes ? Uint8Array.from(resultBytes) : output.value + '\n';
    const url = URL.createObjectURL(new Blob([content], { type: resultBytes ? 'application/octet-stream' : 'text/plain' }));
    const link = document.createElement('a');
    link.href = url; link.download = resultBytes ? chain === 'bitcoin' ? 'signed-bitcoin.psbt' : 'signed-solana-transaction.bin'
      : chain === 'solana' ? 'signed-solana-message.json'
        : resultIsMessage ? 'signed-evm-message-signature.hex' : 'signed-evm-transaction.hex';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return { invalidate, refresh };
}
