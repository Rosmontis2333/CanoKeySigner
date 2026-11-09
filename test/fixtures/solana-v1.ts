import { getCompiledTransactionMessageEncoder, getTransactionConfigMask, getTransactionConfigValues } from '@solana/transaction-messages';
import type { V1CompiledTransactionMessage, CompiledTransactionMessageWithLifetime, V1TransactionConfig } from '@solana/transaction-messages';
import { getTransactionEncoder, getTransactionDecoder } from '@solana/transactions';
import type { TransactionInstruction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { solanaFixture, solanaOther, solanaBlockhash } from './solana';

export type CompiledV1 = V1CompiledTransactionMessage & CompiledTransactionMessageWithLifetime;
export function encodeV1Fixture(compiled: CompiledV1, multi = false) {
  const message = new Uint8Array(getCompiledTransactionMessageEncoder().encode(compiled));
  const signatures = Object.fromEntries(compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts).map((address) => [address,
    multi && address === solanaOther.publicKey.toBase58() ? ed25519.sign(message, solanaOther.secretKey.slice(0, 32)) : null]));
  const transaction = getTransactionDecoder().decode(Buffer.concat([message, ...Object.values(signatures).map((signature) => signature ?? new Uint8Array(64))]));
  const bytes = new Uint8Array(getTransactionEncoder().encode(transaction));
  return { compiled, message, bytes, transaction };
}

export function solanaV1Fixture(multi = false, config: V1TransactionConfig = {
  priorityFeeLamports: 5000n, computeUnitLimit: 200000, loadedAccountsDataSizeLimit: 67108864,
}, instructions?: TransactionInstruction[]) {
  const legacy = solanaFixture(false, multi, instructions).transaction.message;
  const compiled: CompiledV1 = {
    version: 1, header: { numSignerAccounts: legacy.header.numRequiredSignatures,
      numReadonlySignerAccounts: legacy.header.numReadonlySignedAccounts, numReadonlyNonSignerAccounts: legacy.header.numReadonlyUnsignedAccounts },
    configMask: getTransactionConfigMask(config), configValues: getTransactionConfigValues(config),
    lifetimeToken: solanaBlockhash as CompiledTransactionMessageWithLifetime['lifetimeToken'],
    staticAccounts: legacy.staticAccountKeys.map((key) => key.toBase58()) as V1CompiledTransactionMessage['staticAccounts'],
    numStaticAccounts: legacy.staticAccountKeys.length, numInstructions: legacy.compiledInstructions.length,
    instructionHeaders: legacy.compiledInstructions.map((instruction) => ({ programAccountIndex: instruction.programIdIndex,
      numInstructionAccounts: instruction.accountKeyIndexes.length, numInstructionDataBytes: instruction.data.length })),
    instructionPayloads: legacy.compiledInstructions.map((instruction) => ({ instructionAccountIndices: [...instruction.accountKeyIndexes], instructionData: instruction.data })),
  };
  return encodeV1Fixture(compiled, multi);
}
