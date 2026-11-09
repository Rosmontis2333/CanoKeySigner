import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { NETWORK, TEST_NETWORK, Transaction, p2pkh, p2sh, p2wpkh, SigHash } from '@scure/btc-signer';
import { RawOldTx, RawTx } from '@scure/btc-signer/script.js';
import { inspectBitcoinInput } from './input';
import { decodeRawPsbt } from './psbt';
import { getPrevOut } from '@scure/btc-signer/transaction.js';
import { equalBytes, concatBytes } from '@scure/btc-signer/utils.js';

const options = { unknown: 'ignore', proprietary: 'ignore', strictPrevoutValidation: true, allowUnknownOutputs: true } as const;
const MAX_MONEY = 21_000_000n * 100_000_000n;
export interface BitcoinReview {
  readonly chain: 'bitcoin';
  readonly psbtHex: string;
  readonly psbtVersion: 0 | 2;
  readonly publicKeyHex: string;
  readonly network: 'mainnet' | 'testnet';
  readonly signable: boolean;
  readonly jobs: readonly Readonly<{ index: number; digestHex: string; publicKeyHex: string }>[];
  readonly rows: readonly (readonly [string, string])[];
}
const reviews = new WeakSet<BitcoinReview>();

export function decodePsbt(source: string, encoding: string): Uint8Array {
  const text = source.trim();
  if (text.length > 2_097_152) throw new Error('PSBT 超出 1 MiB 限制');
  let bytes: Uint8Array;
  if (encoding === 'hex') {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(text)) throw new Error('PSBT Hex 编码无效');
    bytes = hexToBytes(text);
  } else if (encoding === 'base64') {
    bytes = base64.decode(text);
    if (base64.encode(bytes) !== text) throw new Error('PSBT Base64 必须使用规范填充编码');
  } else throw new Error('请明确选择 Base64 或 Hex 编码');
  if (bytes.length > 1_048_576) throw new Error('PSBT 超出 1 MiB 限制');
  return bytes;
}

export function prepareBitcoinTransaction(source: string, publicKeyHex: string, network: string, encoding = 'base64'): BitcoinReview {
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('必须明确选择 Bitcoin 网络');
  const bytes = decodePsbt(source, encoding);
  const { raw, version: psbtVersion } = decodeRawPsbt(bytes);
  if ((raw.global.txModifiable ?? 0) & ~7) throw new Error('PSBT v2 包含未知的可修改标志');
  if (!raw.inputs.length || raw.inputs.length > 128 || !raw.outputs.length || raw.outputs.length > 128) throw new Error('输入与输出数量必须为 1–128');
  const tx = Transaction.fromPSBT(bytes, options);
  const publicKey = secp256k1.Point.fromBytes(hexToBytes(publicKeyHex)).toBytes(true);
  const ownWitness = p2wpkh(publicKey).script;
  const selectedNetwork = network === 'mainnet' ? NETWORK : TEST_NETWORK;
  const rows: [string, string][] = [['网络（用户选择）', network], ['公钥', bytesToHex(publicKey)],
    ['PSBT 版本', String(psbtVersion)], ['交易版本', String(tx.version)], ['locktime', String(tx.lockTime)],
    ['UTXO 验证范围', '完整前序交易的 txid、vout 和金额已核对；离线无法证明当前未花费']];
  if (psbtVersion === 2) {
    const flags = raw.global.txModifiable;
    rows.push(['Fallback locktime', String(raw.global.fallbackLocktime ?? 0)],
      ['原始可修改标志', flags === undefined ? '未提供，输入与输出均不可修改' : `0x${flags.toString(16).padStart(2, '0')}`],
      ['签名后的可修改范围', 'SIGHASH_ALL 锁定全部输入与输出，清除相应的可修改位。保留其余原始标志和字段。']);
  }
  const jobs: { index: number; digestHex: string; publicKeyHex: string }[] = [];
  let totalIn = 0n;
  let totalOut = 0n;
  const maximumTx = RawOldTx.decode(tx.unsignedTx);
  const maximumWitnesses: Uint8Array[][] = [];
  let locktimeEnabled = false;
  const outpoints = new Set<string>();
  for (let index = 0; index < tx.inputsLength; index++) {
    const input = tx.getInput(index);
    if ((input.sequence ?? 0xffffffff) !== 0xffffffff) locktimeEnabled = true;
    if (!input.nonWitnessUtxo) throw new Error(`输入 ${index} 缺少完整前序交易`);
    if (input.finalScriptSig || input.finalScriptWitness) throw new Error('当前导入流程要求未 finalize 的 PSBT');
    if ((input.sighashType ?? SigHash.ALL) !== SigHash.ALL) throw new Error('仅允许 SIGHASH_ALL');
    if (input.tapInternalKey || input.tapKeySig || input.tapScriptSig?.length) throw new Error('当前不支持 Taproot 输入签名');
    const previous = getPrevOut(input);
    if (previous.amount < 0n || previous.amount > MAX_MONEY) throw new Error('输入金额超出 Bitcoin 范围');
    const outpoint = `${bytesToHex(input.txid!)}:${input.index}`;
    if (outpoints.has(outpoint)) throw new Error('重复输入 outpoint');
    outpoints.add(outpoint);
    const inspected = inspectBitcoinInput(tx, index, publicKey);
    maximumTx.inputs[index]!.finalScriptSig = inspected.scriptSig;
    maximumWitnesses.push(inspected.witness);
    const owned = !!inspected.signingKey;
    const alreadySigned = input.partialSig?.some(([key]) => equalBytes(key, inspected.signingKey ?? publicKey)) ?? false;
    if (inspected.signingKey && !alreadySigned && !inspected.complete) jobs.push({ index, digestHex: bytesToHex(inspected.digest), publicKeyHex: bytesToHex(inspected.signingKey) });
    rows.push([`输入 ${index} / outpoint`, outpoint], [`输入 ${index} / sat`, previous.amount.toString()],
      [`输入 ${index} / 脚本`, bytesToHex(previous.script)],
      [`输入 ${index} / 类型`, inspected.type],
      [`输入 ${index} / 所有权`, owned ? '已匹配当前公钥' : '其他公钥'],
      [`输入 ${index} / sequence`, String(input.sequence ?? 0xffffffff)],
      [`输入 ${index} / RBF`, (input.sequence ?? 0xffffffff) < 0xfffffffe ? '启用' : '未启用'],
      [`输入 ${index} / sighash 与已有签名`, `ALL / ${input.partialSig?.length ?? 0} 条已验证`]);
    if (inspected.type.endsWith('-ms')) rows.push([`输入 ${index} / 多签门槛`, `${inspected.threshold} / ${inspected.keys.length}`],
      [`输入 ${index} / 公钥顺序`, inspected.keys.map((key) => bytesToHex(key)).join('\n')],
      [`输入 ${index} / 完整签名脚本`, bytesToHex(inspected.scriptCode)]);
    if (inspected.signingKey) rows.push([`输入 ${index} / 本机签名公钥`, bytesToHex(inspected.signingKey)]);
    if (input.requiredHeightLocktime !== undefined) rows.push([`输入 ${index} / 最低区块高度`, String(input.requiredHeightLocktime)]);
    if (input.requiredTimeLocktime !== undefined) rows.push([`输入 ${index} / 最早时间（Unix 秒）`, String(input.requiredTimeLocktime)]);
    totalIn += previous.amount;
  }
  for (let index = 0; index < tx.outputsLength; index++) {
    const output = tx.getOutput(index);
    const amount = output.amount!;
    if (amount < 0n || amount > MAX_MONEY) throw new Error('输出金额超出 Bitcoin 范围');
    const script = output.script!;
    const owned = equalBytes(script, ownWitness) || equalBytes(script, p2sh(p2wpkh(publicKey)).script)
      || equalBytes(script, p2pkh(publicKey).script) || equalBytes(script, p2pkh(secp256k1.Point.fromBytes(publicKey).toBytes(false)).script);
    let address = '无标准地址，核对原始脚本';
    try { address = tx.getOutputAddress(index, selectedNetwork) ?? address; } catch { /* Raw script is displayed below. */ }
    rows.push([`输出 ${index} / 地址`, address],
      [`输出 ${index} / sat`, amount.toString()], [`输出 ${index} / 脚本`, bytesToHex(script)],
      [`输出 ${index} / 所有权`, owned ? '已验证匹配本机公钥' : '未证明归属，完整展示']);
    totalOut += amount;
  }
  if (totalIn > MAX_MONEY || totalOut > totalIn) throw new Error('交易总金额或费用无效');
  if (bytes.length + jobs.reduce((size, job) => size + hexToBytes(job.publicKeyHex).length + 76, 0) > 1_048_576) throw new Error('附加签名后 PSBT 将超出 1 MiB 限制');
  if (tx.lockTime) rows.push(['locktime 执行条件', locktimeEnabled ? '至少一个输入使用非 final sequence，锁定时间生效'
    : '全部输入使用 final sequence，锁定时间不限制交易']);
  const strippedSize = RawOldTx.encode(maximumTx).length;
  const totalSize = maximumWitnesses.some((witness) => witness.length)
    ? RawTx.encode({ ...maximumTx, segwitFlag: true, witnesses: maximumWitnesses }).length : strippedSize;
  const estimatedVsize = Math.ceil((strippedSize * 3 + totalSize) / 4);
  const fee = totalIn - totalOut;
  const rateHundredths = fee * 100n / BigInt(estimatedVsize);
  rows.push(['总输入（sat）', totalIn.toString()], ['总输出（sat）', totalOut.toString()], ['矿工费（sat）', fee.toString()],
    ['签名后 vsize 估计上限', String(estimatedVsize)], ['费率估计（sat/vB）', `${rateHundredths / 100n}.${(rateHundredths % 100n).toString().padStart(2, '0')}`],
    ['本次待签输入', jobs.length ? jobs.map((job) => job.index).join(', ') : '无'],
    ['交付格式', `PSBT v${psbtVersion} 部分签名，保留其他签名及未知字段`]);
  const review: BitcoinReview = Object.freeze({ chain: 'bitcoin', psbtHex: bytesToHex(bytes), psbtVersion, publicKeyHex, network,
    signable: jobs.length > 0, jobs: Object.freeze(jobs.map((job) => Object.freeze(job))),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))) });
  reviews.add(review);
  return review;
}

export function assertBitcoinReview(review: BitcoinReview): void {
  if (!reviews.has(review) || !review.signable) throw new Error('Bitcoin 审查对象无效或没有待签输入');
}

/** Verifies every returned signature and checks the complete PSBT field set. */
export function attachBitcoinSignatures(review: BitcoinReview, signatures: readonly string[]): Uint8Array {
  assertBitcoinReview(review);
  if (signatures.length !== review.jobs.length) throw new Error('签名数量与批准任务不符');
  const bytes = hexToBytes(review.psbtHex);
  const { raw: original, version, coder } = decodeRawPsbt(bytes);
  const updated = coder.decode(bytes);
  review.jobs.forEach((job, index) => {
    const key = hexToBytes(job.publicKeyHex);
    const parsed = secp256k1.Signature.fromBytes(hexToBytes(signatures[index]!), 'compact');
    const normalized = parsed.hasHighS() ? new secp256k1.Signature(parsed.r, secp256k1.Point.Fn.ORDER - parsed.s) : parsed;
    if (!secp256k1.verify(normalized.toBytes(), hexToBytes(job.digestHex), key, { prehash: false })) throw new Error('硬件签名无效');
    const input = updated.inputs[job.index]!;
    input.partialSig = [...(input.partialSig ?? []), [key, concatBytes(normalized.toBytes('der'), Uint8Array.of(SigHash.ALL))]];
  });
  // BIP370 requires both modification permissions to be cleared after SIGHASH_ALL.
  if (version === 2 && updated.global.txModifiable !== undefined) updated.global.txModifiable &= ~3;
  const result = coder.encode(updated);
  const restored = coder.decode(result);
  for (const job of review.jobs) {
    const key = hexToBytes(job.publicKeyHex);
    const input = restored.inputs[job.index]!;
    const row = input.partialSig!.findIndex(([publicKey]) => equalBytes(publicKey, key));
    if (row < 0) throw new Error('新增签名缺失');
    input.partialSig!.splice(row, 1);
    if (!original.inputs[job.index]!.partialSig) delete input.partialSig;
  }
  if (version === 2 && original.global.txModifiable !== undefined) {
    if (restored.global.txModifiable !== (original.global.txModifiable & ~3)) throw new Error('PSBT 可修改标志更新无效');
    restored.global.txModifiable = original.global.txModifiable;
  }
  if (!equalBytes(coder.encode(restored), coder.encode(original))) throw new Error('签名附加改变了未批准的 PSBT 字段');
  return result;
}

export function finalizeBitcoinTransaction(review: BitcoinReview, signedPsbt: Uint8Array): Uint8Array {
  assertBitcoinReview(review);
  const { raw: supplied, version, coder } = decodeRawPsbt(signedPsbt);
  if (version !== review.psbtVersion) throw new Error('PSBT 版本与批准的格式不一致');
  const tx = Transaction.fromPSBT(signedPsbt, options);
  const signatures = review.jobs.map((job) => {
    const key = hexToBytes(job.publicKeyHex);
    const signature = tx.getInput(job.index).partialSig?.find(([publicKey]) => equalBytes(publicKey, key))?.[1];
    if (!signature || signature.at(-1) !== SigHash.ALL) throw new Error('缺少批准的签名');
    return bytesToHex(secp256k1.Signature.fromBytes(signature.slice(0, -1), 'der').toBytes('compact'));
  });
  const expected = attachBitcoinSignatures(review, signatures);
  if (!equalBytes(coder.encode(coder.decode(expected)), coder.encode(supplied))) {
    throw new Error('PSBT 包含批准签名之外的变化');
  }
  prepareBitcoinTransaction(base64.encode(signedPsbt), review.publicKeyHex, review.network);
  for (let index = 0; index < tx.inputsLength; index++) {
    if (!inspectBitcoinInput(tx, index, hexToBytes(review.publicKeyHex)).complete) throw new Error('其他输入仍缺少签名，尚未达到脚本门槛');
  }
  tx.finalize();
  if (!tx.isFinal) throw new Error('交易尚未完成全部签名');
  return tx.extract();
}
