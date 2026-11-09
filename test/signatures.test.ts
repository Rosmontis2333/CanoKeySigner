import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  decodeAndVerifyDeviceSignature,
  type DeviceSignatureInput,
  type SignatureApplet,
} from '../src/device/signatures.js';

const message = Buffer.from('CanoKey P0 exact message\x00\xff', 'latin1');
const digest = createHash('sha256').update(message).digest();
const secret = Buffer.alloc(32, 1);
const secpPublicKey = secp256k1.getPublicKey(secret, false);
const secpPrivateKey = createPrivateKey({
  format: 'jwk',
  key: {
    kty: 'EC', crv: 'secp256k1', d: secret.toString('base64url'),
    x: Buffer.from(secpPublicKey.subarray(1, 33)).toString('base64url'),
    y: Buffer.from(secpPublicKey.subarray(33)).toString('base64url'),
  },
});
// Node/OpenSSL signs the original message with SHA256. The device adapter must
// verify exactly that digest, without hashing it again.
const secpDer = sign('sha256', message, secpPrivateKey);
const secpSignature = secp256k1.Signature.fromBytes(secpDer, 'der');
const secpInput = { kind: 'ecdsa-digest', digest, publicKey: secpPublicKey } as const;

// PKCS8 Ed25519 seed fixture, consumed by Node's independent implementation.
const edPrivateKey = createPrivateKey({
  format: 'der', type: 'pkcs8',
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 2)]),
});
const edPublicKey = createPublicKey(edPrivateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const edSignature = sign(null, message, edPrivateKey);
const edInput = { kind: 'ed25519-message', message, publicKey: edPublicKey } as const;

function tlv(tag: number, value: Uint8Array, longLength = false): Uint8Array {
  const header = longLength ? [tag, 0x82, 0, value.length] : [tag, value.length];
  return Uint8Array.from([...header, ...value]);
}

function piv(value: Uint8Array, longLength = false): Uint8Array {
  return tlv(0x7c, tlv(0x82, value, longLength), longLength);
}

function decode(applet: SignatureApplet, data: Uint8Array, input: DeviceSignatureInput): Uint8Array {
  return decodeAndVerifyDeviceSignature(applet, { status: 0x9000, data }, input);
}

test('OpenPGP compact and PIV DER ECDSA responses verify with Node/OpenSSL and normalize high-S', () => {
  const high = secpSignature.hasHighS()
    ? secpSignature
    : new secp256k1.Signature(secpSignature.r, secp256k1.Point.Fn.ORDER - secpSignature.s);
  for (const signature of [secpSignature, high]) {
    const pgp = decode('openpgp', signature.toBytes('compact'), secpInput);
    const pivCompact = decode('piv', piv(signature.toBytes('der')), secpInput);
    assert.deepEqual(pgp, pivCompact);
    const normalized = secp256k1.Signature.fromBytes(pgp);
    assert.equal(normalized.hasHighS(), false);
    assert.equal(verify('sha256', message, secpPrivateKey, normalized.toBytes('der')), true);
  }
});

test('PIV signature containers accept non-minimal BER lengths while DER remains strict', () => {
  assert.deepEqual(
    decode('piv', piv(secpDer, true), secpInput),
    decode('piv', piv(secpDer), secpInput),
  );
  assert.deepEqual(Buffer.from(decode('piv', piv(edSignature, true), edInput)), edSignature);
});

test('Ed25519 verifies the exact original message with Node and preserves signature bytes', () => {
  for (const applet of ['openpgp', 'piv'] as const) {
    const response = applet === 'piv' ? piv(edSignature) : Uint8Array.from(edSignature);
    const signature = decode(applet, response, edInput);
    assert.deepEqual(Buffer.from(signature), edSignature);
    assert.equal(verify(null, message, createPublicKey(edPrivateKey), signature), true);
    signature.fill(0);
    assert.ok(response.some((byte) => byte !== 0));
    assert.throws(() => decode(applet, response, { ...edInput, message: digest }), /exact message/);
    assert.throws(() => decode(applet, response, {
      ...edInput, message: Buffer.concat([message, Buffer.from([0])]),
    }), /exact message/);
  }
});

test('OpenPGP can verify an empty Ed25519 message and PIV rejects its unsupported empty challenge', () => {
  const empty = new Uint8Array();
  const signature = sign(null, empty, edPrivateKey);
  const input = { ...edInput, message: empty };
  assert.deepEqual(Buffer.from(decode('openpgp', signature, input)), signature);
  assert.throws(() => decode('piv', piv(signature), input), /empty message/);
});

test('PIV rejects duplicate, missing, unexpected, truncated and trailing signature fields', () => {
  const field = tlv(0x82, secpDer);
  const cases = [
    new Uint8Array(),
    secpDer,
    tlv(0x7c, new Uint8Array()),
    tlv(0x7c, tlv(0x81, secpDer)),
    tlv(0x7c, Uint8Array.from([...field, 0x83, 0])),
    tlv(0x7c, Uint8Array.from([...tlv(0x82, new Uint8Array([1])), ...tlv(0x82, new Uint8Array([2]))])),
    Uint8Array.from([...piv(new Uint8Array([1])), ...piv(new Uint8Array([2]))]),
    piv(secpDer).subarray(0, -1),
    Uint8Array.from([...piv(secpDer), 0]),
    Uint8Array.from([0x7c, 0x80, 0, 0]),
    new Uint8Array(81),
  ];
  for (const response of cases) assert.throws(() => decode('piv', response, secpInput));
});

test('PIV DER rejects noncanonical sequence/integer lengths, signs, scalars and tails', () => {
  const rLength = secpDer[3]!;
  const rBytes = secpDer.subarray(4, 4 + rLength);
  const sField = secpDer.subarray(4 + rLength);
  const paddedR = Uint8Array.from([
    0x30, secpDer[1]! + 1, 2, rLength + 1, 0, ...rBytes, ...sField,
  ]);
  const cases = [
    Uint8Array.from([0x30, 0x81, secpDer[1]!, ...secpDer.subarray(2)]),
    paddedR,
    Buffer.from('3006020180020101', 'hex'),
    Buffer.from('3006020100020101', 'hex'),
    Buffer.from('3006020101020100', 'hex'),
    Uint8Array.from([...secpDer, 0]),
    Uint8Array.from([0x30, secpDer[1]! + 2, ...secpDer.subarray(2), 5, 0]),
    secpDer.subarray(0, -1),
  ];
  for (const malformed of cases) assert.throws(() => decode('piv', piv(malformed), secpInput));
});

test('signature adapter rejects bad status, wrong encoding, input lengths, key and message', () => {
  const compact = secpSignature.toBytes('compact');
  assert.throws(() => decodeAndVerifyDeviceSignature('openpgp', { status: 0x6982, data: compact }, secpInput), /unsuccessful/);
  assert.throws(() => decode('openpgp', secpDer, secpInput), /64 compact/);
  assert.throws(() => decode('piv', piv(compact), secpInput));
  assert.throws(() => decode('openpgp', new Uint8Array(64), secpInput));
  assert.throws(() => decode('openpgp', compact.subarray(0, 63), secpInput));
  assert.throws(() => decode('openpgp', compact, { ...secpInput, digest: digest.subarray(0, 31) }), /32-byte/);
  assert.throws(() => decode('openpgp', compact, { ...secpInput, digest: new Uint8Array(32) }), /exact digest/);
  assert.throws(() => decode('openpgp', compact, {
    ...secpInput, publicKey: secp256k1.getPublicKey(Buffer.alloc(32, 3)),
  }), /exact digest/);
  assert.throws(() => decode('openpgp', compact, { ...secpInput, publicKey: new Uint8Array(33) }));
  assert.throws(() => decode('openpgp', edSignature.subarray(0, 63), edInput), /64-byte/);
  assert.throws(() => decode('openpgp', edSignature, { ...edInput, publicKey: edPublicKey.subarray(1) }), /32-byte/);
  const corrupt = Uint8Array.from(edSignature);
  corrupt[0] = corrupt[0]! ^ 1;
  assert.throws(() => decode('openpgp', corrupt, edInput), /exact message/);
  const weakPublicKey = Uint8Array.from([1, ...new Uint8Array(31)]);
  const weakSignature = Uint8Array.from([1, ...new Uint8Array(63)]);
  assert.throws(() => decode('openpgp', weakSignature, { ...edInput, publicKey: weakPublicKey }), /exact message/);
});
