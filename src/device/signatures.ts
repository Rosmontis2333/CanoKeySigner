import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { ApduResponse } from './apdu';
import { parseTlv, uniqueTag } from './tlv';

export interface EcdsaDigestInput {
  readonly kind: 'ecdsa-digest';
  readonly digest: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface Ed25519MessageInput {
  readonly kind: 'ed25519-message';
  readonly message: Uint8Array;
  readonly publicKey: Uint8Array;
}

export type DeviceSignatureInput = EcdsaDigestInput | Ed25519MessageInput;
export type SignatureApplet = 'openpgp' | 'piv';

function unwrapPivSignature(data: Uint8Array): Uint8Array {
  // Two BER containers, each with at most two length bytes, plus DER ECDSA72.
  if (data.length > 80) throw new Error('PIV signature response is too long');
  const outer = parseTlv(data);
  const template = uniqueTag(outer, 0x7c);
  if (outer.length !== 1 || !template) throw new Error('Expected one PIV 7C signature template');
  const fields = parseTlv(template);
  const signature = uniqueTag(fields, 0x82);
  if (fields.length !== 1 || !signature) throw new Error('Expected one PIV 82 signature field');
  return signature;
}

/**
 * Decode a successful 3.0.3 signing response and verify it against its exact input.
 * Returns ECDSA as low-S compact r || s, or the unchanged Ed25519 signature bytes.
 * This pure function sends no commands and does not authorize a signing task.
 */
export function decodeAndVerifyDeviceSignature(
  applet: SignatureApplet,
  response: ApduResponse,
  input: DeviceSignatureInput,
): Uint8Array {
  if (response.status !== 0x9000) throw new Error('Cannot accept an unsuccessful signing response');
  if (applet !== 'openpgp' && applet !== 'piv') throw new Error('Unsupported signature applet');
  const signatureBytes = applet === 'piv' ? unwrapPivSignature(response.data) : response.data;

  if (input.kind === 'ecdsa-digest') {
    if (input.digest.length !== 32) throw new Error('ECDSA requires an exact 32-byte digest');
    secp256k1.Point.fromBytes(input.publicKey);
    let signature;
    if (applet === 'openpgp') {
      if (signatureBytes.length !== 64) throw new Error('OpenPGP ECDSA requires 64 compact signature bytes');
      signature = secp256k1.Signature.fromBytes(signatureBytes, 'compact');
    } else {
      if (signatureBytes.length < 8 || signatureBytes.length > 72) {
        throw new Error('PIV ECDSA requires a DER signature of 8 to 72 bytes');
      }
      // Noble rejects non-minimal DER lengths, padded/negative integers, and tails.
      // BER flexibility is confined to the two PIV containers above.
      signature = secp256k1.Signature.fromBytes(signatureBytes, 'der');
    }
    const normalized = signature.hasHighS()
      ? new secp256k1.Signature(signature.r, secp256k1.Point.Fn.ORDER - signature.s)
      : signature;
    const compact = normalized.toBytes('compact');
    if (!secp256k1.verify(compact, input.digest, input.publicKey, { prehash: false })) {
      throw new Error('ECDSA signature does not verify against the exact digest and public key');
    }
    return compact;
  }

  if (input.kind === 'ed25519-message') {
    if (signatureBytes.length !== 64 || input.publicKey.length !== 32) {
      throw new Error('Ed25519 requires a 64-byte signature and a 32-byte public key');
    }
    if (applet === 'piv' && input.message.length === 0) {
      throw new Error('CanoKey 3.0.3 PIV cannot sign an empty message');
    }
    if (!ed25519.verify(signatureBytes, input.message, input.publicKey, { zip215: false })) {
      throw new Error('Ed25519 signature does not verify against the exact message and public key');
    }
    return Uint8Array.from(signatureBytes);
  }

  throw new Error('Unsupported signature input kind');
}
