import { attachEvmSignature } from './signature';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Transaction } from 'micro-eth-signer';

type EvmTransaction = InstanceType<typeof Transaction>;
export type EvmProbeType = 'legacy' | 'eip2930' | 'eip1559';

export interface EvmProbeResult {
  readonly type: EvmProbeType;
  readonly chainId: '31337';
  readonly unsignedHex: string;
  readonly digestHex: string;
  readonly signedHex: string;
  readonly sender: string;
}

/** Pure P0 library check. This does not authorize or perform a device operation. */
export function getEvmProbeDigest(transaction: EvmTransaction): Uint8Array {
  if (!['legacy', 'eip2930', 'eip1559'].includes(transaction.type)) {
    throw new Error('P0 probe supports only legacy, type 1 and type 2 transactions');
  }
  if (transaction.isSigned) {
    throw new Error('P0 probe requires an unsigned transaction');
  }
  if (typeof transaction.raw.chainId !== 'bigint' || transaction.raw.chainId <= 0n) {
    throw new Error('P0 probe requires an explicit positive chainId');
  }
  // The public serializer includes EIP-155 protection for legacy transactions
  // and the EIP-2718 type prefix for typed transactions.
  return keccak_256(transaction.toBytes({ includeSignature: false }));
}

function createProbeTransaction(type: EvmProbeType): EvmTransaction {
  const common = {
    chainId: 31337n,
    nonce: 0n,
    gasLimit: 21000n,
    to: '0x0000000000000000000000000000000000000001',
    value: 0n,
    data: '',
  };
  if (type === 'legacy') {
    return new Transaction(type, { ...common, gasPrice: 1n });
  }
  if (type === 'eip2930') {
    return new Transaction(type, { ...common, gasPrice: 1n, accessList: [] });
  }
  return new Transaction(type, {
    ...common,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    accessList: [],
  });
}

/**
 * P0 feasibility sample, used by tests only. Signs three fixed, zero-value local
 * chain fixtures through an asynchronous callback. The application must add its
 * transaction review and approval flow before introducing transaction signing.
 */
export async function runEvmExternalSignatureProbe(
  approvedPublicKey: Uint8Array,
  signDigest: (digest: Uint8Array) => Promise<Uint8Array>,
): Promise<readonly EvmProbeResult[]> {
  const publicKey = secp256k1.Point.fromBytes(approvedPublicKey).toBytes(true);
  const results: EvmProbeResult[] = [];
  const types: readonly EvmProbeType[] = ['legacy', 'eip2930', 'eip1559'];
  for (const type of types) {
    const transaction = createProbeTransaction(type);
    const digest = getEvmProbeDigest(transaction);
    const signature = await signDigest(digest.slice());
    const signed = attachEvmSignature(transaction, digest, signature, publicKey);
    results.push(Object.freeze({
      type,
      chainId: '31337',
      unsignedHex: transaction.toHex(),
      digestHex: bytesToHex(digest),
      signedHex: signed.toHex(),
      sender: signed.sender,
    }));
  }
  return Object.freeze(results);
}
