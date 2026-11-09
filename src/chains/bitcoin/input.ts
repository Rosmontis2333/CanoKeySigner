import { OutScript, p2pkh, p2wpkh, Transaction, SigHash } from '@scure/btc-signer';
import { getInputType, getPrevOut } from '@scure/btc-signer/transaction.js';
import { RawOldTx, Script } from '@scure/btc-signer/script.js';
import { concatBytes, equalBytes } from '@scure/btc-signer/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Supported templates use no OP_CODESEPARATOR and only SIGHASH_ALL. */
export function inspectBitcoinInput(tx: Transaction, index: number, publicKey: Uint8Array) {
  const input = tx.getInput(index);
  const type = getInputType(input);
  if (!['pkh', 'wpkh', 'sh-wpkh', 'sh-ms', 'wsh-ms', 'sh-wsh-ms'].includes(type.type)) {
    throw new Error(`输入 ${index} 的脚本类型 ${type.type} 尚未支持`);
  }
  if (!equalBytes(OutScript.encode(type.last), type.lastScript)) throw new Error('输入脚本需要规范模板编码');
  if (input.redeemScript && !type.type.startsWith('sh-')) throw new Error('输入带有多余 redeemScript');
  if (input.witnessScript && !type.type.includes('wsh-')) throw new Error('输入带有多余 witnessScript');
  if (type.type === 'sh-ms' && type.lastScript.length > 520) throw new Error('P2SH redeemScript 超出 520 字节');
  const ownPoint = secp256k1.Point.fromBytes(publicKey);
  const ownKeys = [ownPoint.toBytes(true), ownPoint.toBytes(false)];
  let keys: Uint8Array[];
  let threshold = 1;
  if (type.last.type === 'ms') {
    keys = type.last.pubkeys;
    threshold = type.last.m;
    if (threshold < 1 || threshold > keys.length || keys.length > 16) throw new Error('多签门槛或公钥数量无效');
    const points = keys.map((key) => bytesToHex(secp256k1.Point.fromBytes(key).toBytes(true)));
    if (new Set(points).size !== points.length) throw new Error('多签脚本含有重复公钥');
    if (type.txType === 'segwit' && keys.some((key) => key.length !== 33)) throw new Error('SegWit 多签要求压缩公钥');
  } else if (type.last.type === 'pkh' || type.last.type === 'wpkh') {
    const hashScript = type.lastScript;
    keys = ownKeys.filter((key) => (type.last.type !== 'wpkh' || key.length === 33)
      && equalBytes(type.last.type === 'wpkh' ? p2wpkh(key).script : p2pkh(key).script, hashScript));
    // Include the other participant's existing key for signature verification.
    for (const [key] of input.partialSig ?? []) {
      secp256k1.Point.fromBytes(key);
      if ((type.last.type === 'wpkh' && key.length !== 33)
        || !equalBytes(type.last.type === 'wpkh' ? p2wpkh(key).script : p2pkh(key).script, hashScript)) {
        throw new Error(`输入 ${index} 的已有签名公钥不属于脚本`);
      }
      if (!keys.some((candidate) => equalBytes(candidate, key))) keys.push(key);
    }
  } else throw new Error('输入脚本模板无效');
  const signingKey = keys.find((key) => secp256k1.Point.fromBytes(key).equals(ownPoint));
  let digest: Uint8Array;
  if (type.txType === 'legacy') {
    // SIGHASH_ALL serializes all inputs/outputs, with only this input's scriptCode.
    const raw = RawOldTx.decode(tx.unsignedTx);
    raw.inputs.forEach((row, rowIndex) => { row.finalScriptSig = rowIndex === index ? type.lastScript : new Uint8Array(); });
    digest = sha256(sha256(concatBytes(RawOldTx.encode(raw), Uint8Array.of(SigHash.ALL, 0, 0, 0))));
  } else {
    const scriptCode = type.last.type === 'wpkh' ? OutScript.encode({ type: 'pkh', hash: type.last.hash }) : type.lastScript;
    digest = tx.preimageWitnessV0(index, scriptCode, SigHash.ALL, getPrevOut(input).amount);
  }
  for (const [key, signature] of input.partialSig ?? []) {
    if (!keys.some((candidate) => equalBytes(candidate, key)) || signature.at(-1) !== SigHash.ALL
      || !secp256k1.verify(signature.slice(0, -1), digest, key, { prehash: false, format: 'der', lowS: false })) {
      throw new Error(`输入 ${index} 的已有签名或公钥无效`);
    }
  }
  // Conservative maximum scripts, including CompactSize/push overhead at serialization.
  const signature = new Uint8Array(73);
  let scriptSig: Uint8Array = new Uint8Array();
  let witness: Uint8Array[] = [];
  if (type.last.type === 'ms') {
    const signatures = Array.from({ length: threshold }, () => signature);
    if (type.txType === 'legacy') scriptSig = Script.encode([0, ...signatures, type.lastScript]);
    else witness = [new Uint8Array(), ...signatures, type.lastScript];
  } else if (type.last.type === 'pkh') scriptSig = Script.encode([signature, new Uint8Array(65)]);
  else witness = [signature, new Uint8Array(33)];
  if (type.txType === 'segwit' && input.redeemScript) scriptSig = Script.encode([input.redeemScript]);
  return { type: type.type, digest, signingKey, keys, threshold, scriptCode: type.lastScript,
    complete: (input.partialSig?.length ?? 0) >= threshold, scriptSig, witness };
}
