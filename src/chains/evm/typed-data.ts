import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { addr } from 'micro-eth-signer';
import { strictJson } from '../../signing/json';

interface Field { name: string; type: string }
export interface TypedReviewData {
  chainId: string;
  json: string;
  digestHex: string;
  domainHashHex: string;
  messageHashHex: string;
}
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
const utf8 = (text: string) => new TextEncoder().encode(text);
const hashText = (text: string) => keccak_256(utf8(text));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EIP-712 结构必须为对象');
  return value as Record<string, unknown>;
}
function integer(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('EIP-712 整数超出安全精度，请使用字符串');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value) || value.length > 80) {
    throw new Error('EIP-712 整数编码无效');
  }
  return BigInt(value);
}
function word(number: bigint): Uint8Array {
  return hexToBytes(BigInt.asUintN(256, number).toString(16).padStart(64, '0'));
}
function hex(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('EIP-712 bytes 必须使用完整 Hex 字节');
  return hexToBytes(value.slice(2));
}

/** Bounded EIP-712 format encoding. Hash and curve operations use the locked libraries. */
export function reviewTypedData(source: string, expectedChainId?: string): TypedReviewData {
  const root = object(strictJson(source));
  // Check numeric tokens before JSON.parse rounding can hide fractions or lost precision.
  for (const match of source.matchAll(/"(?:[^"\\]|\\.)*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (match[1] && (!/^(0|-?[1-9][0-9]*)$/.test(match[1]) || !Number.isSafeInteger(Number(match[1])))) {
      throw new Error('EIP-712 JSON 数字必须为安全整数十进制字面量，其余整数请使用字符串');
    }
  }
  if (Object.keys(root).some((key) => !['types', 'primaryType', 'domain', 'message'].includes(key))) {
    throw new Error('EIP-712 顶层包含未知字段');
  }
  const rawTypes = object(root.types), domain = object(root.domain), message = object(root.message);
  const types = new Map<string, readonly Field[]>();
  let fieldCount = 0;
  if (Object.keys(rawTypes).length > 64) throw new Error('EIP-712 类型数量超过 64');
  for (const [name, fields] of Object.entries(rawTypes)) {
    if (!identifier.test(name) || reserved.has(name) || /^(address|bool|string|bytes[0-9]*|u?int[0-9]*)$/.test(name) || !Array.isArray(fields)) {
      throw new Error('EIP-712 类型定义无效');
    }
    const seen = new Set<string>();
    const parsed = fields.map((field) => {
      const entry = object(field);
      if (Object.keys(entry).length !== 2 || typeof entry.name !== 'string' || typeof entry.type !== 'string'
        || !identifier.test(entry.name) || reserved.has(entry.name) || seen.has(entry.name) || entry.type.length > 128) {
        throw new Error('EIP-712 字段重复或定义无效');
      }
      if (++fieldCount > 256) throw new Error('EIP-712 字段数量超过 256');
      seen.add(entry.name);
      return { name: entry.name, type: entry.type };
    });
    types.set(name, parsed);
  }
  const standardDomain: Field[] = [
    { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' },
  ];
  if (!types.has('EIP712Domain')) {
    const fields = standardDomain.filter((field) => Object.hasOwn(domain, field.name));
    types.set('EIP712Domain', fields);
    fieldCount += fields.length;
  }
  if (types.size > 64 || fieldCount > 256) throw new Error('EIP-712 类型或字段数量超过 64 / 256');
  for (const field of types.get('EIP712Domain')!) {
    if (!standardDomain.some((standard) => standard.name === field.name && standard.type === field.type)) {
      throw new Error('EIP-712 domain 字段类型无效');
    }
  }
  if (typeof root.primaryType !== 'string' || root.primaryType === 'EIP712Domain' || !types.has(root.primaryType)) {
    throw new Error('EIP-712 primaryType 无效');
  }
  if (!Object.hasOwn(domain, 'chainId') || !types.get('EIP712Domain')!.some((field) => field.name === 'chainId')) throw new Error('EIP-712 domain 必须声明 chainId');
  const chainId = integer(domain.chainId);
  if (chainId <= 0n || chainId >= 1n << 256n) throw new Error('EIP-712 domain chainId 超出有效范围');
  if (expectedChainId !== undefined && (!/^[1-9][0-9]*$/.test(expectedChainId) || expectedChainId.length > 78
    || chainId !== BigInt(expectedChainId))) throw new Error('EIP-712 domain chainId 与会话不一致');
  function baseType(type: string): string {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)(\[(?:[1-9][0-9]*|)\])*$/.exec(type);
    if (!match) throw new Error('EIP-712 字段类型语法无效');
    return match[1]!;
  }
  for (const fields of types.values()) for (const field of fields) {
    const base = baseType(field.type);
    const integerType = /^(u?int)([0-9]+)$/.exec(base);
    const bytesType = /^bytes([0-9]+)$/.exec(base);
    if (integerType) {
      const size = Number(integerType[2]);
      if (size < 8 || size > 256 || size % 8 || String(size) !== integerType[2]) throw new Error('EIP-712 整数位宽无效');
    } else if (bytesType) {
      const size = Number(bytesType[1]);
      if (size < 1 || size > 32 || String(size) !== bytesType[1]) throw new Error('EIP-712 bytes 位宽无效');
    } else if (!types.has(base) && !['address', 'bool', 'string', 'bytes'].includes(base)) {
      throw new Error(`EIP-712 未定义类型 ${base}`);
    }
    for (const [, count] of field.type.matchAll(/\[([0-9]*)\]/g)) {
      if (count && (Number(count) > 256 || !Number.isSafeInteger(Number(count)))) throw new Error('EIP-712 固定数组过大');
    }
  }
  const typeHashes = new Map<string, Uint8Array>();
  let expandedTypeChars = 0;
  function typeHash(name: string): Uint8Array {
    const cached = typeHashes.get(name);
    if (cached) return cached;
    const dependencies = new Set<string>();
    function collect(type: string): void {
      if (dependencies.has(type)) return;
      dependencies.add(type);
      for (const field of types.get(type)!) {
        const base = baseType(field.type);
        if (types.has(base)) collect(base);
      }
    }
    collect(name);
    dependencies.delete(name);
    const typeString = [name, ...Array.from(dependencies).sort()].map((type) =>
      `${type}(${types.get(type)!.map((field) => `${field.type} ${field.name}`).join(',')})`).join('');
    expandedTypeChars += typeString.length;
    if (expandedTypeChars > 524288) throw new Error('EIP-712 展开类型定义超过资源限制');
    const hash = hashText(typeString);
    typeHashes.set(name, hash);
    return hash;
  }
  // Bound every declared type before hardware signing, including unused schema entries.
  for (const name of types.keys()) typeHash(name);
  let nodes = 0;
  function encode(type: string, value: unknown, depth: number): Uint8Array {
    if (++nodes > 2048 || depth > 20) throw new Error('EIP-712 消息结构超出资源限制');
    const array = /^(.*)\[([0-9]*)\]$/.exec(type);
    if (array) {
      if (!Array.isArray(value) || value.length > 256 || (array[2] && value.length !== Number(array[2]))) {
        throw new Error('EIP-712 数组长度无效');
      }
      const hash = keccak_256.create();
      for (const item of value) hash.update(encode(array[1]!, item, depth + 1));
      return hash.digest();
    }
    const fields = types.get(type);
    if (fields) {
      const item = object(value);
      if (Object.keys(item).length !== fields.length || fields.some((field) => !Object.hasOwn(item, field.name))) {
        throw new Error(`EIP-712 ${type} 缺少字段或含有额外字段`);
      }
      const hash = keccak_256.create().update(typeHash(type));
      for (const field of fields) hash.update(encode(field.type, item[field.name], depth + 1));
      return hash.digest();
    }
    if (type === 'string') {
      if (typeof value !== 'string') throw new Error('EIP-712 string 类型无效');
      if (new TextDecoder('utf-8', { fatal: true }).decode(utf8(value)) !== value) throw new Error('EIP-712 字符串含有不完整 Unicode');
      return hashText(value);
    }
    if (type === 'bytes') return keccak_256(hex(value));
    if (type.startsWith('bytes')) {
      const bytes = hex(value);
      if (bytes.length !== Number(type.slice(5))) throw new Error('EIP-712 固定 bytes 长度不符');
      const result = new Uint8Array(32);
      result.set(bytes);
      return result;
    }
    if (type === 'bool') {
      if (typeof value !== 'boolean') throw new Error('EIP-712 bool 必须为布尔值');
      return word(value ? 1n : 0n);
    }
    if (type === 'address') {
      if (typeof value !== 'string' || !addr.isValid(value)) throw new Error('EIP-712 address 无效');
      return word(BigInt(value));
    }
    const number = integer(value), signed = type.startsWith('int');
    const width = BigInt(Number(type.slice(signed ? 3 : 4)));
    const lower = signed ? -(1n << (width - 1n)) : 0n;
    const upper = signed ? 1n << (width - 1n) : 1n << width;
    if (number < lower || number >= upper) throw new Error('EIP-712 整数超出声明位宽');
    return word(number);
  }
  const domainHash = encode('EIP712Domain', domain, 0), messageHash = encode(root.primaryType, message, 0);
  return {
    chainId: chainId.toString(),
    json: JSON.stringify(root),
    digestHex: bytesToHex(keccak_256(concatBytes(Uint8Array.of(0x19, 1), domainHash, messageHash))),
    domainHashHex: bytesToHex(domainHash), messageHashHex: bytesToHex(messageHash),
  };
}
