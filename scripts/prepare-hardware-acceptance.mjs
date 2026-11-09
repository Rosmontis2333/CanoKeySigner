import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { base64 } from '@scure/base';
import { Psbt, Transaction as BitcoinTransaction, payments, networks } from 'bitcoinjs-lib';
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as Legacy from 'ox/TransactionEnvelopeLegacy';
import * as AccessList from 'ox/TransactionEnvelopeEip2930';
import * as DynamicFee from 'ox/TransactionEnvelopeEip1559';
import * as Hash from 'ox/Hash';
import { prepareEvmTransaction } from '../src/chains/evm/transaction.ts';
import { prepareBitcoinTransaction } from '../src/chains/bitcoin/transaction.ts';
import { prepareSolanaTransaction } from '../src/chains/solana/transaction.ts';
import { prepareSolanaTextMessage } from '../src/chains/solana/message.ts';
import { verifyOpenPgpEvidence } from './verify-openpgp-evidence.mjs';

assert.equal(process.argv.length, 4, 'Usage: npx tsx scripts/prepare-hardware-acceptance.mjs evidence.json new-output-directory');
const evidencePath = resolve(process.argv[2]), outputDirectory = resolve(process.argv[3]);
assert.ok((await stat(evidencePath)).size <= 1048576, 'Evidence exceeds 1 MiB');
const evidenceBytes = await readFile(evidencePath);
const evidence = JSON.parse(evidenceBytes.toString('utf8'));
verifyOpenPgpEvidence(evidence);
const secp = evidence.records.find((record) => record.slot === 'AUT' && record.algorithm === 'secp256k1');
const ed = evidence.records.find((record) => record.slot === 'SIG' && record.algorithm === 'ed25519');
assert.ok(secp && ed, 'Expected previously verified AUT/secp256k1 and SIG/Ed25519 records');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const files = new Map(), cases = [];
function add(name, content, details) {
  const bytes = Buffer.from(content);
  files.set(name, bytes);
  cases.push({ inputFile: name, inputBytes: bytes.length, inputSha256: digest(bytes), status: 'prepared-awaiting-hardware', ...details });
}

const evmAddress = '0x' + Hash.keccak256('0x' + secp.publicKeyHex.slice(2)).slice(-40);
for (const [type, reference] of [['0', Legacy], ['1', AccessList], ['2', DynamicFee]]) {
  const fields = { type, chainId: '31337', nonce: '0', gasLimit: '21000', to: '0x1111111111111111111111111111111111111111', value: '0', data: '0x',
    ...(type === '2' ? { maxFeePerGas: '2', maxPriorityFeePerGas: '1' } : { gasPrice: '2' }), ...(type === '0' ? {} : { accessList: [] }) };
  const review = prepareEvmTransaction(json(fields), secp.publicKeyHex);
  const independent = { chainId: 31337, nonce: 0n, gas: 21000n, to: fields.to, value: 0n, data: '0x',
    ...(type === '2' ? { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } : { gasPrice: 2n }), ...(type === '0' ? {} : { accessList: [] }) };
  assert.equal(review.signable, true);
  assert.equal(review.sender.toLowerCase(), evmAddress);
  assert.equal('0x' + review.digestHex, reference.getSignPayload(independent));
  add(`evm-type-${type}.json`, json(fields), { coin: 'evm', mode: 'transaction', slot: 'AUT', network: '31337', publicKeyHex: secp.publicKeyHex,
    address: review.sender, digestHex: review.digestHex, unsignedHex: review.unsignedHex, reference: `Ox ${type === '0' ? 'Legacy' : type === '1' ? 'EIP-2930' : 'EIP-1559'} signing digest` });
}

const uncompressed = Buffer.from(secp.publicKeyHex, 'hex');
const compressed = Buffer.concat([Buffer.from([2 | (uncompressed[64] & 1)]), uncompressed.subarray(1, 33)]);
const payment = payments.p2wpkh({ pubkey: compressed, network: networks.testnet });
const destination = payments.p2wpkh({ pubkey: Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'), network: networks.testnet });
const previous = new BitcoinTransaction(); previous.version = 2;
previous.addInput(Buffer.alloc(32, 0x42), 0);
previous.addOutput(payment.output, 100000n);
const psbt = new Psbt({ network: networks.testnet }); psbt.setVersion(2);
psbt.addInput({ hash: previous.getId(), index: 0, sequence: 0xfffffffd, nonWitnessUtxo: previous.toBuffer(),
  witnessUtxo: { script: payment.output, value: 100000n }, sighashType: BitcoinTransaction.SIGHASH_ALL });
psbt.addOutput({ script: payment.output, value: 50000n }); psbt.addOutput({ script: destination.output, value: 48000n });
const bitcoin = prepareBitcoinTransaction(psbt.toBase64(), secp.publicKeyHex, 'testnet');
assert.equal(bitcoin.signable, true); assert.equal(bitcoin.jobs.length, 1);
const transaction = new BitcoinTransaction(); transaction.version = 2;
transaction.addInput(previous.getHash(), 0, 0xfffffffd);
transaction.addOutput(payment.output, 50000n); transaction.addOutput(destination.output, 48000n);
const scriptCode = payments.p2pkh({ pubkey: compressed, network: networks.testnet }).output;
assert.equal(bitcoin.jobs[0].digestHex, Buffer.from(transaction.hashForWitnessV0(0, scriptCode, 100000n, BitcoinTransaction.SIGHASH_ALL)).toString('hex'));
add('bitcoin-p2wpkh.psbt', psbt.toBuffer(), { coin: 'bitcoin', mode: 'transaction', slot: 'AUT', network: 'testnet', publicKeyHex: secp.publicKeyHex,
  address: payment.address, unsignedTransactionHex: transaction.toHex(), digestHex: bitcoin.jobs[0].digestHex,
  previousTransactionHex: previous.toHex(), inputAmountSat: '100000', feeSat: '2000', reference: 'bitcoinjs-lib PSBT and BIP-143 digest' });

const signer = new PublicKey(Buffer.from(ed.publicKeyHex, 'hex'));
const blockhash = new PublicKey(Buffer.alloc(32, 0x42)).toBase58();
const instruction = SystemProgram.transfer({ fromPubkey: signer, toPubkey: new PublicKey(Buffer.alloc(32, 0x33)), lamports: 0n });
for (const version of ['legacy', 'v0']) {
  const builder = new TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: [instruction] });
  const message = version === 'legacy' ? builder.compileToLegacyMessage() : builder.compileToV0Message();
  const transaction = new VersionedTransaction(message), encoded = base64.encode(transaction.serialize());
  const review = prepareSolanaTransaction(encoded, ed.publicKeyHex, 'devnet');
  assert.equal(review.signable, true);
  assert.equal(review.messageHex, Buffer.from(message.serialize()).toString('hex'));
  add(`solana-${version}.base64`, encoded + '\n', { coin: 'solana', mode: 'transaction', slot: 'SIG', network: 'devnet', encoding: 'base64', format: 'transaction',
    publicKeyHex: ed.publicKeyHex, address: signer.toBase58(), messageHex: review.messageHex, reference: 'Solana Web3.js message and transaction serialization' });
}
for (const length of [255, 256, 1331]) {
  const prefix = 'CanoKeySigner synthetic hardware acceptance. ';
  const text = prefix.padEnd(length - 50, 'X');
  const review = prepareSolanaTextMessage(text, ed.publicKeyHex, 'devnet');
  const message = Buffer.concat([Buffer.from([255]), Buffer.from('solana offchain', 'ascii'), Buffer.from([1, 1]), signer.toBuffer(), Buffer.from(text)]);
  assert.equal(review.signable, true); assert.equal(message.length, length); assert.equal(review.messageHex, message.toString('hex'));
  add(`solana-message-${length}.txt`, text, { coin: 'solana', mode: 'offchain-text', slot: 'SIG', network: 'devnet', publicKeyHex: ed.publicKeyHex,
    address: signer.toBase58(), messageBytes: length, messageHex: review.messageHex, reference: 'Independent fixed-layout offchain v1 serialization' });
}

await mkdir(outputDirectory);
try {
  for (const [name, content] of files) await writeFile(join(outputDirectory, name), content);
  await writeFile(join(outputDirectory, 'manifest.json'), json({ format: 'canokeysigner-hardware-acceptance-v1',
    status: 'prepared-awaiting-hardware', evidenceSha256: digest(evidenceBytes),
    keySource: 'Previously verified public evidence. Re-read the connected device and match both public keys before signing.',
    purpose: 'Offline application signing tests. EVM uses local chainId 31337, Bitcoin uses an unconfirmed synthetic previous transaction, Solana uses a fixed placeholder blockhash. Import and sign without broadcasting.',
    cases }));
} catch (error) { await rm(outputDirectory, { recursive: true, force: true }); throw error; }
console.log(`Prepared ${cases.length} independently checked inputs at ${outputDirectory}`);
console.log('Hardware execution remains pending. Re-read and match the connected public keys before using these files.');
