import { base58, base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { strictJson } from '../../signing/json';
import type { V1Resources } from './v1';

export class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) throw new Error('Solana 数据截断或长度越界');
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  byte(): number { return this.take(1)[0]!; }
  short(): number {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.byte();
      if (i === 2 && byte > 3) throw new Error('short_vec 超出 u16');
      value |= (byte & 127) << (7 * i);
      if (!(byte & 128)) {
        if (i && byte === 0) throw new Error('非规范 short_vec');
        return value;
      }
    }
    throw new Error('无效 short_vec');
  }
  end(): void { if (this.offset !== this.bytes.length) throw new Error('Solana 数据包含尾随字节'); }
}
export function shortVector(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new Error('short_vec 长度无效');
  const bytes: number[] = [];
  do {
    const byte = value & 127; value >>>= 7;
    bytes.push(value ? byte | 128 : byte);
  } while (value);
  return Uint8Array.from(bytes);
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function decodeSolana(source: string, encoding: string): Uint8Array {
  const text = source.trim();
  if (text.length > 10000) throw new Error('Solana 输入过大');
  let bytes: Uint8Array;
  if (encoding === 'base64') {
    bytes = base64.decode(text);
    if (base64.encode(bytes) !== text) throw new Error('Base64 编码不规范');
  } else if (encoding === 'base58') {
    bytes = base58.decode(text);
    if (base58.encode(bytes) !== text) throw new Error('Base58 编码不规范');
  } else if (encoding === 'hex') {
    if (!/^(?:[a-fA-F0-9]{2})+$/.test(text)) throw new Error('Hex 编码无效');
    bytes = hexToBytes(text);
  } else throw new Error('请明确选择 Solana 编码');
  if (!bytes.length || bytes.length > 4096) throw new Error('Solana 字节长度无效');
  return bytes;
}
export function addressBytes(address: string): Uint8Array {
  if (address.length < 32 || address.length > 44) throw new Error('Solana 地址长度无效');
  const bytes = base58.decode(address);
  if (bytes.length !== 32 || base58.encode(bytes) !== address) throw new Error('Solana 地址无效');
  return bytes;
}
export interface Lookup { address: string; writable: number[]; readonly: number[] }
export interface CompiledInstruction { programIndex: number; accounts: number[]; data: Uint8Array }
export interface Message {
  version: 'legacy' | 'v0' | 'v1';
  resources?: V1Resources;
  signers: number;
  readonlySigners: number;
  readonlyUnsigned: number;
  addresses: string[];
  blockhash: string;
  instructions: CompiledInstruction[];
  lookups: Lookup[];
}
export function parseMessage(bytes: Uint8Array): Message {
  const reader = new Reader(bytes);
  let first = reader.byte();
  let version: Message['version'] = 'legacy';
  if (first & 128) {
    if (first !== 128) throw new Error(`Solana 消息版本 ${first & 127} 需要独立解析器，当前支持 legacy/v0`);
    version = 'v0'; first = reader.byte();
  }
  const signers = first, readonlySigners = reader.byte(), readonlyUnsigned = reader.byte();
  const count = reader.short();
  if (!count || count > 256 || signers < 1 || signers > count || readonlySigners >= signers || readonlyUnsigned > count - signers) throw new Error('Solana 账户 header 无效');
  const addresses = Array.from({ length: count }, () => base58.encode(reader.take(32)));
  const blockhash = base58.encode(reader.take(32));
  const instructionCount = reader.short();
  if (!instructionCount || instructionCount > 64) throw new Error('指令数量必须为 1–64');
  const instructions = Array.from({ length: instructionCount }, () => {
    const programIndex = reader.byte();
    if (programIndex < signers || programIndex >= count) throw new Error('Program ID 必须位于静态非签名账户中');
    const accounts = Array.from(reader.take(reader.short()));
    const data = reader.take(reader.short());
    return { programIndex, accounts, data };
  });
  const lookups: Lookup[] = [];
  if (version === 'v0') {
    const lookupCount = reader.short();
    if (lookupCount > 32) throw new Error('ALT 引用数量过多');
    for (let i = 0; i < lookupCount; i++) {
      const address = base58.encode(reader.take(32));
      const writable = Array.from(reader.take(reader.short()));
      const readonly = Array.from(reader.take(reader.short()));
      if (!writable.length && !readonly.length) throw new Error('空 ALT 引用');
      lookups.push({ address, writable, readonly });
    }
  }
  reader.end();
  const total = count + lookups.reduce((sum, lookup) => sum + lookup.writable.length + lookup.readonly.length, 0);
  if (total > 256) throw new Error('账户总数超过 256');
  for (const instruction of instructions) {
    if (instruction.accounts.some((index) => index >= total)) throw new Error('指令账户索引越界');
  }
  return { version, signers, readonlySigners, readonlyUnsigned, addresses, blockhash, instructions, lookups };
}

const ALT_OWNER = 'AddressLookupTab1e1111111111111111111111111';
export class MissingSolanaLookupError extends Error {
  constructor(address: string) { super(`ALT 未解析 ${address}`); }
}
/** Offline snapshots contain raw RPC account data, with explicit source and slot. */
export function resolveLookups(message: Message, snapshotJson: string, network: string): { writable: string[]; readonly: string[]; sources: string[] } {
  const writable: string[] = [], readonly: string[] = [], sources: string[] = [];
  if (!message.lookups.length) return { writable, readonly, sources };
  const snapshots = strictJson(snapshotJson, 1048576);
  if (!Array.isArray(snapshots) || snapshots.length > 32) throw new Error('ALT 快照必须是至多 32 个对象的数组');
  const byAddress = new Map<string, { addresses: string[]; activeCount: number; source: string }>();
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('ALT 快照格式无效');
    const raw = snapshot as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !['address', 'owner', 'dataBase64', 'source', 'contextSlot', 'network'].includes(key))) throw new Error('ALT 快照包含未知字段');
    if (typeof raw.address !== 'string' || raw.owner !== ALT_OWNER || typeof raw.dataBase64 !== 'string'
      || typeof raw.source !== 'string' || !raw.source.trim() || raw.source.length > 500
      || raw.network !== network || typeof raw.contextSlot !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(raw.contextSlot)) throw new Error('ALT owner、网络、来源或 slot 无效');
    addressBytes(raw.address);
    if (byAddress.has(raw.address)) throw new Error('ALT 快照地址重复');
    if (raw.dataBase64.length > 11000) throw new Error('ALT 账户数据过大');
    const data = base64.decode(raw.dataBase64);
    if (base64.encode(data) !== raw.dataBase64 || data.length < 56 || data.length > 8248 || (data.length - 56) % 32) throw new Error('ALT 账户结构无效');
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    if (view.getUint32(0, true) !== 1 || view.getBigUint64(4, true) !== 0xffffffffffffffffn || data[21]! > 1) throw new Error('ALT 未初始化、已停用或 authority 编码无效');
    const context = BigInt(raw.contextSlot), extended = view.getBigUint64(12, true);
    const addresses: string[] = [];
    for (let offset = 56; offset < data.length; offset += 32) addresses.push(base58.encode(data.slice(offset, offset + 32)));
    if (context > 0xffffffffffffffffn || context < extended || data[20]! > addresses.length) throw new Error('ALT 快照 slot 或扩展边界无效');
    byAddress.set(raw.address, { addresses, activeCount: context === extended ? data[20]! : addresses.length,
      source: `离线快照，未经链上验证 · ${raw.source} · slot ${raw.contextSlot}` });
  }
  const used = new Set<string>();
  for (const lookup of message.lookups) {
    if (used.has(lookup.address)) throw new Error('重复 ALT 引用');
    used.add(lookup.address);
    const snapshot = byAddress.get(lookup.address);
    if (!snapshot) throw new MissingSolanaLookupError(lookup.address);
    const indexes = [...lookup.writable, ...lookup.readonly];
    if (new Set(indexes).size !== indexes.length || indexes.some((index) => index >= snapshot.activeCount)) throw new Error('ALT 索引重复、越界或尚未激活');
    writable.push(...lookup.writable.map((index) => snapshot.addresses[index]!));
    readonly.push(...lookup.readonly.map((index) => snapshot.addresses[index]!));
    sources.push(`${lookup.address} · ${snapshot.source} · writable [${lookup.writable}] · readonly [${lookup.readonly}]`);
  }
  return { writable, readonly, sources };
}
export const hex = bytesToHex;
