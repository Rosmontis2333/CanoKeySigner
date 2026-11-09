import { bytesToHex } from '@noble/hashes/utils.js';
import { RawPSBTV0, RawPSBTV2 } from '@scure/btc-signer/psbt.js';

/** Bound v2 map counts before the library allocates or decodes the map arrays. */
function psbtVersion(bytes: Uint8Array): 0 | 2 {
  if (bytes.length > 1_048_576 || bytesToHex(bytes.subarray(0, 5)) !== '70736274ff') throw new Error('PSBT 头部或大小无效');
  let offset = 5;
  function compactSize(limit: number, end = bytes.length): number {
    if (offset >= end) throw new Error('PSBT CompactSize 被截断');
    const prefix = bytes[offset++]!;
    const size = prefix < 253 ? 0 : prefix === 253 ? 2 : prefix === 254 ? 4 : 8;
    if (offset + size > end) throw new Error('PSBT CompactSize 被截断');
    let value = BigInt(prefix);
    if (size) {
      value = 0n;
      for (let index = 0; index < size; index++) value |= BigInt(bytes[offset++]!) << BigInt(index * 8);
      if (value < (size === 2 ? 253n : size === 4 ? 65536n : 4294967296n)) throw new Error('PSBT CompactSize 非规范编码');
    }
    if (value > BigInt(limit)) throw new Error('PSBT 长度或输入/输出数量超过限制');
    return Number(value);
  }
  let version = 0;
  let inputCount: number | undefined, outputCount: number | undefined;
  const seen = new Set<number>();
  while (true) {
    const keyLength = compactSize(bytes.length - offset);
    if (!keyLength) break;
    if (offset + keyLength > bytes.length) throw new Error('PSBT key 被截断');
    const tag = keyLength === 1 ? bytes[offset] : undefined;
    offset += keyLength;
    const valueLength = compactSize(bytes.length - offset);
    const end = offset + valueLength;
    if (end > bytes.length) throw new Error('PSBT value 被截断');
    if (tag === 0xfb || tag === 4 || tag === 5) {
      if (seen.has(tag)) throw new Error('PSBT 全局字段重复');
      seen.add(tag);
      if (tag === 0xfb) {
        if (valueLength !== 4) throw new Error('PSBT 版本字段长度无效');
        version = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
      } else {
        const count = compactSize(128, end);
        if (offset !== end) throw new Error('PSBT count 包含尾随字节');
        if (tag === 4) inputCount = count;
        else outputCount = count;
      }
    }
    offset = end;
  }
  if (version !== 0 && version !== 2) throw new Error('当前支持 PSBT v0 / v2');
  if (version === 2 && (inputCount === undefined || outputCount === undefined)) throw new Error('PSBT v2 缺少输入或输出数量');
  return version;
}

export function decodeRawPsbt(bytes: Uint8Array) {
  const version = psbtVersion(bytes);
  const coder = version === 0 ? RawPSBTV0 : RawPSBTV2;
  return { raw: coder.decode(bytes), version, coder };
}
