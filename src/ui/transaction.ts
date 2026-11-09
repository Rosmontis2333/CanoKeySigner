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

export function mountTransactionApp(access: DeviceAccess, chain: 'evm' | 'bitcoin' | 'solana'): { invalidate(): void; refresh(): void } {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(chain === 'evm' ? id : id.replace('transaction-', chain + '-')) as T;
  const source = get<HTMLTextAreaElement>('transaction-source');
  const kind = chain !== 'bitcoin' ? get<HTMLSelectElement>('transaction-kind') : undefined;
  const network = chain === 'evm' ? undefined : get<HTMLSelectElement>('transaction-network');
  const encoding = get<HTMLSelectElement>('transaction-encoding');
  const outputEncoding = get<HTMLSelectElement>('transaction-output-encoding');
  const format = get<HTMLSelectElement>('transaction-format');
  const snapshots = get<HTMLTextAreaElement>('transaction-snapshots');
  const rpcPane = chain !== 'bitcoin' ? get('transaction-rpc') : undefined;
  const rpcEndpoint = chain !== 'bitcoin' ? get<HTMLSelectElement>('transaction-rpc-endpoint') : undefined;
  const rpcRead = chain !== 'bitcoin' ? get<HTMLButtonElement>('transaction-rpc-read') : undefined;
  const rpcCancel = chain !== 'bitcoin' ? get<HTMLButtonElement>('transaction-rpc-cancel') : undefined;
  const broadcast = chain !== 'bitcoin' ? mountBroadcastApp(chain) : undefined;
  const encodeResult = (bytes: Uint8Array) => outputEncoding.value === 'hex' ? bytesToHex(bytes)
    : outputEncoding.value === 'base58' ? base58.encode(bytes) : base64.encode(bytes);
  let resultBytes: Uint8Array | undefined;
  let finalizedBytes: Uint8Array | undefined;
  const finalize = get<HTMLButtonElement>('transaction-finalize');
  const slot = get<HTMLSelectElement>('transaction-slot');
  const file = get<HTMLInputElement>('transaction-file');
  const parse = get<HTMLButtonElement>('transaction-parse');
  const confirm = get<HTMLInputElement>('transaction-confirm');
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
    confirm.checked = false;
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
  function refresh(): void {
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
    sign.disabled = signing || access.busy() || !review?.signable || !confirm.checked;
    pin.disabled = signing || access.busy();
    if (rpcPane && rpcEndpoint && rpcRead) {
      rpcPane.hidden = !__WALLETCONNECT__ || kind?.value !== 'transaction';
      const previousEndpoint = rpcEndpoint.value;
      rpcEndpoint.replaceChildren();
      let rpcChainId = '';
      if (chain === 'evm' && kind?.value === 'transaction') {
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
  for (const control of [source, ...(network ? [network] : []), slot, ...(kind ? [kind] : []), ...(encoding ? [encoding] : []), ...(format ? [format] : []), ...(snapshots ? [snapshots] : []), ...(rpcEndpoint ? [rpcEndpoint] : [])]) control.addEventListener('input', () => {
    invalidate(); refresh();
  });
  if (kind && chain === 'evm') {
    const descriptions = {
      transaction: { label: '交易 JSON / Hex', badge: 'type 0 · 1 · 2',
        help: get('transaction-help').textContent ?? '', placeholder: source.placeholder },
      personal_sign: { label: '消息正文（UTF-8）', badge: 'EIP-191',
        help: '输入完整可阅读消息。审查会显示转义正文和精确字节。签名可能被用于登录或授权，请核对网站、账户和用途。',
        placeholder: '输入需要签署的完整消息' },
      eth_signTypedData_v4: { label: 'EIP-712 JSON', badge: 'EIP-712 v4',
        help: '导入包含 types、primaryType、domain 和 message 的完整 JSON。网络从 Domain chainId 读取，所有字段均在签名前展示。',
        placeholder: '{"types":{"Notice":[{"name":"contents","type":"string"}]},"primaryType":"Notice","domain":{"chainId":"1"},"message":{"contents":"Hello"}}' },
    };
    kind.addEventListener('change', () => {
      const description = descriptions[kind.value as keyof typeof descriptions];
      if (!description) return;
      get('transaction-source-label').textContent = description.label;
      get('transaction-kind-badge').textContent = description.badge;
      get('transaction-help').textContent = description.help;
      source.placeholder = description.placeholder;
      parse.textContent = kind.value === 'transaction' ? '解析并审查交易' : '解析并审查消息';
      status.textContent = '请导入并审查完整签名内容。';
    });
  }
  if (kind && chain === 'solana') {
    const transactionHelp = get('transaction-help').textContent;
    kind.addEventListener('change', () => {
      const message = kind.value !== 'transaction', text = kind.value === 'offchain-text';
      for (const control of [format, get('transaction-format-label'), snapshots, get('transaction-snapshots-label')]) control.hidden = message;
      for (const control of [encoding, get('transaction-encoding-label')]) control.hidden = text;
      for (const control of [outputEncoding, get('transaction-output-encoding-label')]) control.hidden = message;
      get('transaction-kind-badge').textContent = message ? 'Solana offchain' : 'legacy · v0 · v1';
      get('transaction-help').textContent = text ? '输入完整可阅读正文，最多 1281 字节。将生成绑定当前 signer 的 Solana offchain v1 消息，审查展示精确签名字节。请在正文中写明网站、nonce、时间和用途。'
        : message ? '导入标准 Solana offchain v0 / v1 消息，按原始字节签名。所列 signer、正文与域分离格式会完整核对，原始文本和交易字节请使用对应入口。' : transactionHelp;
      get('transaction-source-label').textContent = text ? '离链消息正文（UTF-8）' : message ? 'Solana offchain Base64 / Base58 / Hex' : 'Solana Base64 / Base58 / Hex';
      get('transaction-file-label').textContent = text ? '导入消息正文文本' : message ? '导入离链消息文件' : '导入交易文件';
      source.placeholder = text ? '写明网站、账户、nonce、时间和本次签名用途' : message ? '粘贴已明确编码的 Solana offchain 消息' : '粘贴已明确编码的 Solana 交易或消息';
      file.accept = text ? '.txt' : '.bin,.hex,.txt,.base64,.base58';
      parse.textContent = message ? '解析并审查离链消息' : '解析并审查交易';
      status.textContent = '请导入并审查完整签名内容。';
      download.textContent = message ? '下载消息与签名 JSON' : '下载二进制 transaction';
    });
  }
  outputEncoding?.addEventListener('change', () => {
    if (resultBytes) output.value = encodeResult(resultBytes);
  });
  confirm.addEventListener('change', refresh);
  for (const control of [source, network, file, encoding, format, snapshots]) {
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
      if (chain === 'evm' || kind?.value === 'offchain-text') return { text: await selected.text(), binary: false };
      const bytes = new Uint8Array(await selected.arrayBuffer());
      const binary = chain === 'solana' ? encoding.value === 'binary' : bytes.length >= 5 && bytesToHex(bytes.slice(0, 5)) === '70736274ff';
      return { text: binary ? base64.encode(bytes) : new TextDecoder().decode(bytes), binary };
    };
    void read().then(({ text, binary }) => {
      if (request !== fileGeneration || revision !== generation || signing) return;
      invalidate();
      source.value = text;
      if (binary) encoding.value = 'base64';
      status.textContent = '文件已载入，请解析并审查。';
    }).catch(() => { status.textContent = '读取文件失败'; });
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
    if (!__WALLETCONNECT__ || chain === 'bitcoin' || kind?.value !== 'transaction' || access.busy() || signing) return;
    const key = access.slots().find((key) => key.slot === slot.value);
    const endpoints = chain === 'evm' ? __EVM_RPC_ENDPOINTS__ : __SOLANA_RPC_ENDPOINTS__;
    const endpoint = rpcEndpoint!.value ? endpoints[Number(rpcEndpoint!.value)] : undefined;
    if (!key || !endpoint) return;
    invalidate();
    const abort = new AbortController(), revision = generation; rpcController = abort;
    const input = { source: source.value, publicKeyHex: key.publicKeyHex, network: (network?.value ?? ''), encoding: encoding?.value ?? '', format: format?.value ?? '' };
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
      const method = kind?.value;
      if (chain === 'evm') review = method === 'personal_sign' || method === 'eth_signTypedData_v4'
        ? prepareEvmMessage(method, source.value, key.publicKeyHex) : prepareEvmTransaction(source.value, key.publicKeyHex);
      else if (chain === 'bitcoin') review = prepareBitcoinTransaction(source.value, key.publicKeyHex, (network?.value ?? ''), encoding.value);
      else if (method === 'offchain-text') review = prepareSolanaTextMessage(source.value, key.publicKeyHex, (network?.value ?? ''));
      else if (method === 'offchain-import') review = prepareSolanaMessage(source.value, key.publicKeyHex, (network?.value ?? ''), encoding.value);
      else review = prepareSolanaTransaction(source.value, key.publicKeyHex, (network?.value ?? ''), encoding.value, format.value, snapshots.value || '[]');
      renderReview(review);
    } catch (error) { status.textContent = error instanceof Error ? error.message : '解析失败'; }
    refresh();
  });
  sign.addEventListener('click', () => {
    if (!review || !confirm.checked || signing || access.busy()) return;
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
        confirm.checked = false;
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
        : kind?.value === 'transaction' ? 'signed-evm-transaction.hex' : 'signed-evm-message-signature.hex';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return { invalidate, refresh };
}
