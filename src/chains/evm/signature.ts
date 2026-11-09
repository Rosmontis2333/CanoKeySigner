import { secp256k1 } from '@noble/curves/secp256k1.js';
import { addr, Transaction } from 'micro-eth-signer';
type EvmTransaction = InstanceType<typeof Transaction>;

export function verifyEvmCompactSignature(
  digest: Uint8Array,
  signatureBytes: Uint8Array,
  publicKey: Uint8Array,
) {
  const signature = secp256k1.Signature.fromBytes(signatureBytes, 'compact');
  const normalized = signature.hasHighS()
    ? new secp256k1.Signature(signature.r, secp256k1.Point.Fn.ORDER - signature.s)
    : signature;
  if (!secp256k1.verify(normalized.toBytes('compact'), digest, publicKey, { prehash: false })) {
    throw new Error('External EVM signature does not match the approved public key and digest');
  }

  const approvedPoint = secp256k1.Point.fromBytes(publicKey);
  // Ethereum carries only parity 0/1, so signatures requiring recovery 2/3
  // cannot be represented and must be rejected.
  for (const yParity of [0, 1]) {
    let matches = false;
    try {
      matches = normalized.addRecoveryBit(yParity).recoverPublicKey(digest).equals(approvedPoint);
    } catch {
      continue;
    }
    if (!matches) continue;
    return { normalized, yParity };
  }
  throw new Error('External signature has no Ethereum recovery parity for the approved key');
}

export function attachEvmSignature(
  transaction: EvmTransaction,
  digest: Uint8Array,
  signatureBytes: Uint8Array,
  publicKey: Uint8Array,
): EvmTransaction {
  const { normalized, yParity } = verifyEvmCompactSignature(digest, signatureBytes, publicKey);
  const signed = new Transaction(
    transaction.type,
    { ...transaction.raw, r: normalized.r, s: normalized.s, yParity },
    { strict: false },
  );
  if (!signed.verifySignature() || signed.sender !== addr.fromPublicKey(publicKey)) {
    throw new Error('Serialized EVM signature failed account verification');
  }
  if (signed.toHex({ includeSignature: false }) !== transaction.toHex()) {
    throw new Error('External signature changed the EVM transaction fields');
  }
  const decoded = Transaction.fromBytes(signed.toBytes());
  if (!decoded.verifySignature() || decoded.sender !== signed.sender) {
    throw new Error('EVM serialization roundtrip failed signature verification');
  }
  return signed;
}
