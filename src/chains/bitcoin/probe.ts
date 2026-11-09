import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p2pkh, p2sh, p2wpkh, SigHash, Transaction } from '@scure/btc-signer';
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js';
import { getPrevOut } from '@scure/btc-signer/transaction.js';
import { concatBytes, equalBytes } from '@scure/btc-signer/utils.js';

/**
 * P0 compatibility experiment, for synthetic transactions only. This is not an
 * application signing entry point and has no transaction review/approval flow.
 * The callback returns a 64-byte r || s signature of the supplied SHA256d digest.
 */
export async function probeBitcoinExternalSigning(
  psbt: Uint8Array,
  inputIndex: number,
  publicKey: Uint8Array,
  signDigest: (digest: Uint8Array) => Promise<Uint8Array>,
): Promise<{ psbt: Uint8Array; digest: Uint8Array }> {
  if (psbt.length > 1_048_576) throw new Error('P0 PSBT exceeds 1 MiB');
  const original = RawPSBTV0.decode(Uint8Array.from(psbt));
  if ((original.global.version ?? 0) !== 0) throw new Error('P0 requires PSBT v0');
  const key = Uint8Array.from(publicKey);
  if (key.length !== 33) throw new Error('P0 requires a compressed secp256k1 public key');
  secp256k1.Point.fromBytes(key);
  const transaction = Transaction.fromPSBT(RawPSBTV0.encode(original), {
    unknown: 'ignore',
    proprietary: 'ignore',
    strictPrevoutValidation: true,
  });
  if (!Number.isSafeInteger(inputIndex) || inputIndex < 0 || inputIndex >= transaction.inputsLength) {
    throw new Error('Invalid input index');
  }
  // preimageWitnessV0 is public but does not enforce signIdx's prevout policy.
  // fromPSBT validates txids, output indices and witness/non-witness consistency.
  for (let index = 0; index < transaction.inputsLength; index++) {
    if (!transaction.getInput(index).nonWitnessUtxo) {
      throw new Error('P0 requires full previous transactions for every input');
    }
  }
  if (transaction.fee < 0n) throw new Error('Outputs exceed verified inputs');
  const input = transaction.getInput(inputIndex);
  if ((input.sighashType ?? SigHash.ALL) !== SigHash.ALL) {
    throw new Error('P0 permits only SIGHASH_ALL');
  }
  if (input.finalScriptSig || input.finalScriptWitness) throw new Error('Input is already finalized');
  if (input.partialSig?.some(([existingKey]) => equalBytes(existingKey, key))) {
    throw new Error('Selected public key already has a signature');
  }
  const previousOutput = getPrevOut(input);
  const native = p2wpkh(key);
  const wrapped = p2sh(native);
  const nativeMatches = equalBytes(previousOutput.script, native.script) && !input.redeemScript;
  const wrappedMatches = equalBytes(previousOutput.script, wrapped.script)
    && input.redeemScript !== undefined && equalBytes(input.redeemScript, native.script);
  if ((!nativeMatches && !wrappedMatches) || input.witnessScript) {
    throw new Error('P0 supports only matching P2WPKH and P2SH-P2WPKH inputs');
  }
  const digest = transaction.preimageWitnessV0(
    inputIndex, p2pkh(key).script, SigHash.ALL, previousOutput.amount,
  );
  const rawSignature = await signDigest(Uint8Array.from(digest));
  if (rawSignature.length !== 64) throw new Error('Expected a 64-byte compact ECDSA signature');
  const parsed = secp256k1.Signature.fromBytes(rawSignature, 'compact');
  const normalized = parsed.hasHighS()
    ? new secp256k1.Signature(parsed.r, secp256k1.Point.Fn.ORDER - parsed.s)
    : parsed;
  const compact = normalized.toBytes('compact');
  if (!secp256k1.verify(compact, digest, key, { prehash: false })) {
    throw new Error('External signature does not verify against the selected public key');
  }
  const signature = concatBytes(normalized.toBytes('der'), new Uint8Array([SigHash.ALL]));
  transaction.updateInput(inputIndex, { partialSig: [[key, signature]] });
  const signedPsbt = transaction.toPSBT(0);
  // Check the entire PSBT, including opaque fields, after removing our one new row.
  const restored = RawPSBTV0.decode(signedPsbt);
  const restoredInput = restored.inputs[inputIndex]!;
  const addedRow = restoredInput.partialSig!.findIndex(([rowKey]) => equalBytes(rowKey, key));
  if (addedRow < 0) throw new Error('External signature was not attached');
  restoredInput.partialSig!.splice(addedRow, 1);
  if (!original.inputs[inputIndex]!.partialSig) delete restoredInput.partialSig;
  if (!equalBytes(RawPSBTV0.encode(restored), RawPSBTV0.encode(original))) {
    throw new Error('External signature attachment changed other PSBT fields');
  }
  return { psbt: signedPsbt, digest: Uint8Array.from(digest) };
}
