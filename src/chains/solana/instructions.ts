import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, addressBytes, hex } from './codec';
import { reviewTokenInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './token';
import type { CompiledInstruction, Message } from './codec';

export interface Account { address: string; signer: boolean; writable: boolean }
const SYSTEM = '11111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const BLOCKHASH_SYSVAR = 'SysvarRecentB1ockHashes11111111111111111111';
export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM_ID): string {
  if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(tokenProgram)) throw new Error('ATA Token 程序无效');
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(concat(addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint), Uint8Array.of(bump),
      addressBytes(ATA), new TextEncoder().encode('ProgramDerivedAddress')));
    try { ed25519.Point.fromBytes(hash, true); } catch { return base58.encode(hash); }
  }
  throw new Error('无法派生 Associated Token Address');
}

export function reviewInstructions(instructions: readonly CompiledInstruction[], accounts: readonly Account[], version: Message['version'] = 'legacy'): {
  rows: [string, string][]; understood: boolean;
} {
  const rows: [string, string][] = [];
  let understood = true;
  const computeSeen = new Set<number>();
  let computeLimit: bigint | undefined;
  let computePrice: bigint | undefined;
  instructions.forEach((instruction, index) => {
    const program = accounts[instruction.programIndex]!;
    const selected = instruction.accounts.map((account) => accounts[account]!);
    const bytes = instruction.data;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const prefix = `指令 ${index}`;
    rows.push([`${prefix} / Program`, program.address], [`${prefix} / 账户索引`, instruction.accounts.join(', ')], [`${prefix} / 原始数据`, hex(bytes)]);
    const add = (name: string, value: string) => rows.push([`${prefix} / ${name}`, value]);
    const count = (value: number) => { if (selected.length !== value) throw new Error(`${prefix} 账户数量无效`); };
    const writable = (position: number) => { if (!selected[position]?.writable) throw new Error(`${prefix} 缺少可写账户 ${position}`); };
    const signer = (position: number) => { if (!selected[position]?.signer) throw new Error(`${prefix} 缺少签名者 ${position}`); };
    const length = (value: number) => { if (bytes.length !== value) throw new Error(`${prefix} 数据长度无效`); };
    const unknown = () => { understood = false; add('策略', '未知指令，当前拒签'); };
    if (program.address === SYSTEM && bytes.length >= 4) {
      const type = view.getUint32(0, true);
      if (type === 2) {
        length(12); count(2); writable(0); writable(1); signer(0);
        add('操作', 'SOL 转账'); add('付款人', selected[0]!.address); add('收款人', selected[1]!.address);
        add('金额（lamports）', view.getBigUint64(4, true).toString());
      } else if (type === 0) {
        length(52); count(2); writable(0); writable(1); signer(0); signer(1);
        add('操作', '创建账户'); add('付款人', selected[0]!.address); add('新账户', selected[1]!.address);
        add('金额（lamports）', view.getBigUint64(4, true).toString()); add('空间（字节）', view.getBigUint64(12, true).toString());
        add('新 Owner', base58.encode(bytes.slice(20)));
      } else if (type === 4) {
        length(4); count(3); writable(0); signer(2);
        if (index !== 0 || selected[1]!.address !== BLOCKHASH_SYSVAR) throw new Error('Durable nonce advance 必须为第一条指令并使用正确 sysvar');
        add('操作', '推进 durable nonce，message blockhash 解释为 nonce 值'); add('Nonce 账户', selected[0]!.address); add('Nonce authority', selected[2]!.address);
        add('Nonce 状态来源', '未读取链上 nonce 账户，需核对其当前值及 authority');
      } else if (type === 1 || type === 8) {
        length(type === 1 ? 36 : 12); count(1); writable(0); signer(0);
        add('操作', type === 1 ? '修改账户 Owner' : '分配账户空间'); add('账户', selected[0]!.address);
        add(type === 1 ? '新 Owner' : '空间（字节）', type === 1 ? base58.encode(bytes.slice(4)) : view.getBigUint64(4, true).toString());
      } else unknown();
    } else if (program.address === COMPUTE && version === 'v1') {
      add('操作', 'v1 ComputeBudget no-op');
      add('效果', '此指令按 v1 规则作为 no-op 执行，不配置资源或优先费。');
    } else if (program.address === COMPUTE && bytes.length) {
      count(0);
      const type = bytes[0]!;
      if (computeSeen.has(type)) throw new Error('重复 Compute Budget 参数');
      computeSeen.add(type);
      if (type === 3) {
        length(9); computePrice = view.getBigUint64(1, true); add('CU price（micro-lamports/CU）', computePrice.toString());
      } else if ([1, 2, 4].includes(type)) {
        length(5);
        const value = view.getUint32(1, true);
        if (!value || (type === 1 && (value < 32768 || value > 262144 || value % 1024))
          || (type === 2 && value > 1_400_000) || (type === 4 && value > 67108864)) throw new Error('Compute Budget 参数越界');
        if (type === 2) computeLimit = BigInt(value);
        add(type === 1 ? 'Heap frame（字节）' : type === 2 ? 'CU limit' : 'Loaded accounts data limit（字节）', value.toString());
      } else unknown();
    } else if ([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(program.address) && bytes.length) {
      const token = reviewTokenInstruction(program.address, bytes, selected, prefix);
      rows.push(...token.rows); understood &&= token.understood;
    } else if (program.address === ATA && (!bytes.length || (bytes.length === 1 && [0, 1].includes(bytes[0]!)))) {
      if (selected.length !== 6 && selected.length !== 7) throw new Error('ATA 账户数量无效');
      writable(0); signer(0); writable(1);
      if (selected.length === 7 && selected[6]!.address !== 'SysvarRent111111111111111111111111111111111') throw new Error('ATA Rent sysvar 无效');
      if (selected[4]!.address !== SYSTEM || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(selected[5]!.address)
        || selected[1]!.address !== associatedTokenAddress(selected[2]!.address, selected[3]!.address, selected[5]!.address)) throw new Error('ATA 地址或依赖程序不匹配');
      add('操作', bytes[0] === 1 ? '幂等创建 Associated Token Account' : '创建 Associated Token Account');
      add('租金付款人', selected[0]!.address); add('ATA', selected[1]!.address); add('Owner', selected[2]!.address); add('Mint', selected[3]!.address);
      add('Token 程序', selected[5]!.address);
      add('租金', '需链上账户与租金上下文确定');
    } else if (program.address === MEMO) {
      selected.forEach((_account, position) => signer(position));
      const memo = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      add('操作', 'Memo'); add('文本', JSON.stringify(memo).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
    } else unknown();
  });
  if (computePrice !== undefined && computeLimit !== undefined) rows.push(['显式 CU 配置优先费（lamports）', ((computePrice * computeLimit + 999999n) / 1000000n).toString()]);
  return { rows, understood };
}
