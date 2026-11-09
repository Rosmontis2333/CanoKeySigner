import { readFileSync } from 'node:fs';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

interface TokenVector {
  name: string;
  program: string;
  dataHex: string;
  accounts: { address: string; isSigner: boolean; isWritable: boolean }[];
  operation: string;
  multi: boolean;
  signable: boolean;
}
export const token2022Vectors = (JSON.parse(readFileSync(new URL('./token2022-vectors.json', import.meta.url), 'utf8')) as {
  vectors: TokenVector[];
}).vectors;

export function token2022Instruction(vector: TokenVector): TransactionInstruction {
  return new TransactionInstruction({ programId: new PublicKey(vector.program), data: Buffer.from(vector.dataHex, 'hex'),
    keys: vector.accounts.map(({ address, isSigner, isWritable }) => ({ pubkey: new PublicKey(address), isSigner, isWritable })) });
}
