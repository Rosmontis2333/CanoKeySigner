import assert from 'node:assert/strict';
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const CASE_LENGTHS = { basic: undefined, 'length-255': 255, 'length-256': 256, 'length-1331': 1331 };

function hex(value, name, length) {
  assert.equal(typeof value, 'string', `${name} must be a hexadecimal string`);
  assert.match(value, /^(?:[0-9a-f]{2})*$/, `${name} must use lower-case even-length hex`);
  assert.ok(value.length <= 2680, `${name} exceeds the P0 command bound`);
  const bytes = Buffer.from(value, 'hex');
  if (length !== undefined) assert.equal(bytes.length, length, `${name} has the wrong byte length`);
  return bytes;
}

function assertNormalizedEcdsa(raw, normalized) {
  const rawR = BigInt(`0x${raw.subarray(0, 32).toString('hex')}`);
  const rawS = BigInt(`0x${raw.subarray(32).toString('hex')}`);
  const r = BigInt(`0x${normalized.subarray(0, 32).toString('hex')}`);
  const s = BigInt(`0x${normalized.subarray(32).toString('hex')}`);
  assert.ok(r > 0n && r < SECP256K1_ORDER, 'Invalid ECDSA r scalar');
  assert.ok(s > 0n && s <= SECP256K1_ORDER / 2n, 'Normalized ECDSA signature is not low-S');
  assert.equal(rawR, r, 'ECDSA normalization changed r');
  assert.ok(rawS === s || rawS === SECP256K1_ORDER - s, 'ECDSA normalization changed the signature');
}

/** Independently verifies public evidence with Node/OpenSSL, without application libraries. */
export function verifyOpenPgpEvidence(document) {
  assert.ok(document && typeof document === 'object' && !Array.isArray(document), 'Expected an evidence object');
  assert.equal(document.format, 'canokeysigner-openpgp-p0-v1', 'Unsupported evidence format');
  assert.ok(Array.isArray(document.records), 'Missing public signature records');
  assert.ok(document.records.length > 0 && document.records.length <= 32, 'Invalid record count');
  return document.records.map((record, index) => {
    assert.ok(record && typeof record === 'object' && !Array.isArray(record), 'Invalid evidence record');
    assert.ok(['SIG', 'AUT'].includes(record.slot), 'Invalid OpenPGP slot');
    assert.ok(Object.hasOwn(CASE_LENGTHS, record.caseId), 'Unknown diagnostic case');
    const message = hex(record.messageHex, 'messageHex');
    const input = hex(record.inputHex, 'inputHex');
    const publicKey = hex(record.publicKeyHex, 'publicKeyHex');
    const rawSignature = hex(record.rawSignatureHex, 'rawSignatureHex', 64);
    const signature = hex(record.signatureHex, 'signatureHex', 64);
    assert.equal(message.length, record.messageLength, 'Recorded message length is inconsistent');
    assert.equal(input.length, record.inputLength, 'Recorded input length is inconsistent');
    if (record.caseId !== 'basic') {
      assert.equal(message.length, CASE_LENGTHS[record.caseId], 'Message does not match the declared length case');
    }

    let hash;
    let options;
    if (record.algorithm === 'secp256k1') {
      assert.equal(record.caseId, 'basic', 'ECDSA diagnostics use the basic digest case');
      assert.equal(publicKey.length, 65, 'Expected an uncompressed secp256k1 public key');
      assert.equal(publicKey[0], 4, 'Invalid secp256k1 public key prefix');
      const key = createPublicKey({
        format: 'jwk',
        key: {
          kty: 'EC', crv: 'secp256k1',
          x: publicKey.subarray(1, 33).toString('base64url'),
          y: publicKey.subarray(33).toString('base64url'),
        },
      });
      const digest = createHash('sha256').update(message).digest();
      assert.equal(input.length, 32, 'ECDSA input must be exactly 32 bytes');
      assert.ok(timingSafeEqual(input, digest), 'ECDSA input differs from SHA256 of the recorded message');
      assertNormalizedEcdsa(rawSignature, signature);
      hash = 'sha256';
      options = { key, dsaEncoding: 'ieee-p1363' };
    } else {
      assert.equal(record.algorithm, 'ed25519', 'Unsupported algorithm');
      assert.equal(publicKey.length, 32, 'Expected a 32-byte Ed25519 public key');
      assert.deepEqual(input, message, 'Ed25519 input differs from the exact recorded message');
      assert.deepEqual(signature, rawSignature, 'Ed25519 signature bytes changed');
      hash = null;
      options = createPublicKey({
        format: 'der', type: 'spki',
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
      });
    }

    const changed = message.length ? Buffer.from(message) : Buffer.from([1]);
    if (message.length) changed[0] ^= 1;
    for (const [name, bytes] of [['raw', rawSignature], ['normalized', signature]]) {
      assert.equal(verify(hash, message, options, bytes), true, `Record ${index} ${name} signature failed verification`);
      assert.equal(verify(hash, changed, options, bytes), false, `Record ${index} ${name} signature accepted a changed message`);
    }
    // The browser's verified/authenticationCleared fields are reported claims.
    // This verifier establishes signature correctness from the public bytes.
    return {
      record: index,
      slot: record.slot,
      algorithm: record.algorithm,
      caseId: record.caseId,
      messageBytes: message.length,
      inputBytes: input.length,
      publicKeyBytes: publicKey.length,
      rawSignatureBytes: rawSignature.length,
      signatureBytes: signature.length,
      rawSignatureVerified: true,
      normalizedSignatureVerified: true,
      changedMessageRejected: true,
      authenticationClearedReported: record.authenticationCleared === true,
      implementation: `Node ${process.version} / OpenSSL ${process.versions.openssl}`,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-openpgp-evidence.mjs evidence.json');
    const filename = process.argv[2];
    assert.ok((await stat(filename)).size <= 1_048_576, 'Evidence file exceeds 1 MiB');
    const document = JSON.parse(await readFile(filename, 'utf8'));
    process.stdout.write(`${JSON.stringify({ results: verifyOpenPgpEvidence(document) }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Independent OpenPGP verification failed. ${error.message}\n`);
    process.exitCode = 1;
  }
}
