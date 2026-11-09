import assert from 'node:assert/strict';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { addr, Transaction } from 'micro-eth-signer';
import { getEvmProbeDigest, runEvmExternalSignatureProbe } from '../src/chains/evm/probe.js';

// Published EIP-155 example key, used only with synthetic test data.
const privateKey = hexToBytes('46'.repeat(32));
const publicKey = secp256k1.getPublicKey(privateKey);

test('public serializer reproduces the EIP-155 published digest and signed transaction', () => {
  // https://eips.ethereum.org/EIPS/eip-155#example
  const transaction = new Transaction('legacy', {
    chainId: 1n,
    nonce: 9n,
    gasPrice: 20_000_000_000n,
    gasLimit: 21_000n,
    to: '0x3535353535353535353535353535353535353535',
    value: 1_000_000_000_000_000_000n,
    data: '',
  });
  assert.equal(
    transaction.toHex(),
    '0xec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080',
  );
  assert.equal(
    bytesToHex(getEvmProbeDigest(transaction)),
    'daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53',
  );
  const signature = secp256k1.Signature.fromBytes(
    secp256k1.sign(getEvmProbeDigest(transaction), privateKey, {
      prehash: false,
      format: 'recovered',
    }),
    'recovered',
  );
  const signed = new Transaction('legacy', {
    ...transaction.raw,
    r: signature.r,
    s: signature.s,
    yParity: signature.recovery!,
  });
  assert.equal(signed.v, 37n);
  assert.equal(
    signed.toHex(),
    '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83',
  );
  assert.equal(signed.sender, addr.fromPublicKey(publicKey));
});

test('async external compact signatures work for all three fixed transaction types', async () => {
  const digests: string[] = [];
  const results = await runEvmExternalSignatureProbe(publicKey, async (digest) => {
    await Promise.resolve();
    digests.push(bytesToHex(digest));
    return secp256k1.sign(digest, privateKey, { prehash: false });
  });
  assert.equal(results.length, 3);
  assert.equal(new Set(digests).size, 3);
  assert.deepEqual(results.map((result) => result.type), ['legacy', 'eip2930', 'eip1559']);
  for (const result of results) {
    const signed = Transaction.fromHex(result.signedHex);
    assert.equal(signed.raw.chainId, 31337n);
    assert.equal(signed.raw.value, 0n);
    assert.equal(signed.sender, addr.fromPublicKey(publicKey));
    assert.equal(signed.verifySignature(), true);
    assert.equal(signed.toHex({ includeSignature: false }), result.unsignedHex);
    assert.equal(bytesToHex(getEvmProbeDigest(signed.removeSignature())), result.digestHex);
    assert.equal(signed.toHex(), result.signedHex);
  }
  assert.equal(Object.isFrozen(results), true);
  assert.equal(Object.isFrozen(results[0]), true);
});

test('high-S hardware signatures are normalized before recovery parity is selected', async () => {
  const results = await runEvmExternalSignatureProbe(publicKey, async (digest) => {
    const low = secp256k1.Signature.fromBytes(secp256k1.sign(digest, privateKey, { prehash: false }));
    return new secp256k1.Signature(low.r, secp256k1.Point.Fn.ORDER - low.s).toBytes('compact');
  });
  for (const result of results) {
    const signed = Transaction.fromHex(result.signedHex);
    assert.ok(signed.raw.s! <= secp256k1.Point.Fn.ORDER / 2n);
    assert.equal(signed.sender, addr.fromPublicKey(publicKey));
    assert.equal(signed.verifySignature(), true);
  }
});

test('wrong signer, double-hashed digest and malformed signature stop the probe immediately', async () => {
  const wrongKey = hexToBytes('47'.repeat(32));
  let calls = 0;
  await assert.rejects(runEvmExternalSignatureProbe(publicKey, async (digest) => {
    calls++;
    return secp256k1.sign(digest, wrongKey, { prehash: false });
  }), /does not match/);
  assert.equal(calls, 1);
  await assert.rejects(runEvmExternalSignatureProbe(publicKey, async (digest) => {
    return secp256k1.sign(digest, privateKey);
  }), /does not match/);
  await assert.rejects(runEvmExternalSignatureProbe(publicKey, async () => new Uint8Array(63)));
  await assert.rejects(runEvmExternalSignatureProbe(publicKey, async () => new Uint8Array(64)));
});

test('callback mutation cannot replace the approved digest', async () => {
  await assert.rejects(runEvmExternalSignatureProbe(publicKey, async (digest) => {
    digest.fill(0);
    return secp256k1.sign(digest, privateKey, { prehash: false });
  }), /does not match/);
});

test('unprotected legacy and already-signed transactions are refused by the digest check', () => {
  const legacy = new Transaction('legacy', {
    nonce: 0n,
    gasLimit: 21000n,
    gasPrice: 1n,
    to: '0x0000000000000000000000000000000000000001',
    value: 0n,
    data: '',
  });
  assert.throws(() => getEvmProbeDigest(legacy), /explicit positive chainId/);
  const protectedLegacy = new Transaction('legacy', { ...legacy.raw, chainId: 31337n });
  assert.throws(() => getEvmProbeDigest(protectedLegacy.signBy(privateKey, false)), /unsigned/);
});
