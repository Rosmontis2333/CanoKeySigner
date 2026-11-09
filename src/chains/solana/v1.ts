import { base58 } from '@scure/base';
import { Reader } from './codec';
import type { Message } from './codec';

export interface V1Resources {
  mask: number;
  priorityFee: bigint;
  computeUnitLimit: number;
  loadedAccountsDataLimit: number;
  heapSize: number;
}

/** SIMD-0385 message bytes include 0x81 and exclude the trailing signatures. */
export function parseV1Message(bytes: Uint8Array): Message & { resources: V1Resources } {
  const reader = new Reader(bytes);
  if (reader.byte() !== 0x81) throw new Error('Solana v1 版本前缀无效');
  const signers = reader.byte(), readonlySigners = reader.byte(), readonlyUnsigned = reader.byte();
  const maskBytes = reader.take(4);
  const mask = new DataView(maskBytes.buffer, maskBytes.byteOffset, 4).getUint32(0, true);
  if (mask > 31 || (mask & 3) === 1 || (mask & 3) === 2) throw new Error('Solana v1 配置 mask 含未知位或不完整 priority fee');
  const blockhash = base58.encode(reader.take(32));
  const instructionCount = reader.byte(), count = reader.byte();
  if (signers < 1 || signers > 12 || readonlySigners >= signers || count < signers + readonlyUnsigned || count > 96) throw new Error('Solana v1 账户 header 无效');
  if (instructionCount > 64) throw new Error('Solana v1 指令数量超过 64');
  const addresses = Array.from({ length: count }, () => base58.encode(reader.take(32)));
  const u32 = () => {
    const data = reader.take(4);
    return new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  };
  let priorityFee = 0n;
  if ((mask & 3) === 3) {
    const data = reader.take(8);
    priorityFee = new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0, true);
  }
  const computeUnitLimit = mask & 4 ? u32() : 0;
  const loadedAccountsDataLimit = mask & 8 ? u32() : 0;
  const heapSize = mask & 16 ? u32() : 32768;
  if (heapSize < 32768 || heapSize > 262144 || heapSize % 1024) throw new Error('Solana v1 heap size 无效');
  const headers = Array.from({ length: instructionCount }, () => {
    const programIndex = reader.byte(), accountCount = reader.byte();
    const dataLength = reader.take(2);
    const length = dataLength[0]! | dataLength[1]! << 8;
    if (!programIndex || programIndex >= count) throw new Error('Solana v1 Program 索引无效');
    return { programIndex, accountCount, length };
  });
  const instructions = headers.map(({ programIndex, accountCount, length }) => {
    const accounts = Array.from(reader.take(accountCount));
    if (accounts.some((index) => index >= count)) throw new Error('Solana v1 指令账户索引越界');
    return { programIndex, accounts, data: reader.take(length) };
  });
  reader.end();
  return { version: 'v1', signers, readonlySigners, readonlyUnsigned, addresses, blockhash, instructions, lookups: [],
    resources: { mask, priorityFee, computeUnitLimit, loadedAccountsDataLimit, heapSize } };
}
