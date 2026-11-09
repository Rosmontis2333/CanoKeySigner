import { attachSolanaSignature, assertSolanaReview } from '../chains/solana/transaction';
import { attachBitcoinSignatures, assertBitcoinReview } from '../chains/bitcoin/transaction';
import { assertEvmReview } from '../chains/evm/transaction';
import { assertEvmMessageReview } from '../chains/evm/message';
import { assertSolanaMessageReview } from '../chains/solana/message';
import { consumeBitcoinApproval, consumeEvmApproval, consumeSolanaApproval, consumeEvmMessageApproval, consumeSolanaMessageApproval } from '../signing/approval';
import type { TransactionApproval, EvmMessageApproval, SolanaMessageApproval } from '../signing/approval';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { transmit } from './apdu';
import type { ApduCommand, ApduResponse, ApduTransport } from './apdu';
import { decodeAndVerifyDeviceSignature } from './signatures';
import { parseTlv, uniqueTag } from './tlv';

export type OpenPgpSlotName = 'SIG' | 'AUT';
export type OpenPgpAlgorithm = 'secp256k1' | 'ed25519';
export type OpenPgpDiagnosticCase = 'basic' | 'length-255' | 'length-256' | 'length-1331';

export interface OpenPgpSlot {
  readonly slot: OpenPgpSlotName;
  readonly algorithm: OpenPgpAlgorithm | 'unsupported' | 'missing';
  readonly algorithmHex: string;
  readonly publicKeyHex: string;
  readonly uifHex: string;
}

export interface OpenPgpDiscovery {
  readonly slots: readonly OpenPgpSlot[];
  readonly passwordStatusHex: string;
  readonly pw1Retries: number;
  readonly decAlgorithmHex: string;
  readonly touchCacheSeconds: number;
}

export interface OpenPgpDiagnostic {
  readonly slot: OpenPgpSlotName;
  readonly algorithm: OpenPgpAlgorithm;
  readonly algorithmHex: string;
  readonly publicKeyHex: string;
  readonly uifHex: string;
  readonly caseId: OpenPgpDiagnosticCase;
  readonly messageHex: string;
  readonly messageLength: number;
  readonly inputHex: string;
  readonly inputLength: number;
}

export interface OpenPgpDiagnosticEvidence extends OpenPgpDiagnostic {
  readonly rawSignatureHex: string;
  readonly signatureHex: string;
  readonly verified: true;
  readonly authenticationCleared: boolean;
}

export class OpenPgpDiagnosticError extends Error {
  constructor(message: string, readonly authenticationCleared: boolean) {
    super(message);
    this.name = 'OpenPgpDiagnosticError';
  }
}

const algorithms = { secp256k1: '132b8104000a', ed25519: '162b06010401da470f01' } as const;
const preparedDiagnostics = new WeakSet<OpenPgpDiagnostic>();
const activeTransports = new WeakSet<ApduTransport>();
const batchTransports = new WeakSet<ApduTransport>();

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('OpenPGP operation was cancelled');
}

/** Guards every APDU, including GET RESPONSE, and clears the encoded buffers. */
async function exchange(
  transport: ApduTransport,
  command: ApduCommand,
  signal: AbortSignal | undefined,
): Promise<ApduResponse> {
  const responseBuffers: Uint8Array[] = [];
  const guarded: ApduTransport = {
    async exchange(bytes) {
      try {
        checkSignal(signal);
        const response = await transport.exchange(bytes);
        responseBuffers.push(response);
        checkSignal(signal);
        return response;
      } finally {
        bytes.fill(0);
      }
    },
  };
  try {
    checkSignal(signal);
    return await transmit(guarded, command);
  } finally {
    for (const buffer of responseBuffers) buffer.fill(0);
  }
}

function requireSuccess(response: ApduResponse, operation: string): Uint8Array {
  if (response.status !== 0x9000) {
    throw new Error(`${operation} failed, SW=${response.status.toString(16).padStart(4, '0')}`);
  }
  return response.data;
}

function validatePublicKey(algorithm: OpenPgpAlgorithm, publicKeyHex: string): void {
  const key = hexToBytes(publicKeyHex);
  if (algorithm === 'secp256k1') {
    if (key.length !== 65 || key[0] !== 4) throw new Error('Invalid OpenPGP secp256k1 public key encoding');
    secp256k1.Point.fromBytes(key);
  } else {
    if (key.length !== 32) throw new Error('Invalid OpenPGP Ed25519 public key encoding');
    const point = ed25519.Point.fromBytes(key, false);
    if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('Invalid OpenPGP Ed25519 public key');
  }
}

async function readDiscovery(transport: ApduTransport, signal: AbortSignal | undefined): Promise<OpenPgpDiscovery> {
  requireSuccess(await exchange(transport, {
    cla: 0, ins: 0xa4, p1: 4, p2: 0, data: Uint8Array.of(0xd2, 0x76, 0, 1, 0x24, 1),
  }, signal), 'Select OpenPGP');
  const application = requireSuccess(await exchange(transport, {
    cla: 0, ins: 0xca, p1: 0, p2: 0x6e, le: 256,
  }, signal), 'Read OpenPGP application data');
  const outer = parseTlv(application);
  const root = uniqueTag(outer, 0x6e);
  if (outer.length !== 1 || !root) throw new Error('Invalid OpenPGP application data container');
  const discretionary = uniqueTag(parseTlv(root), 0x73);
  if (!discretionary) throw new Error('Missing OpenPGP discretionary attributes');
  const attributes = parseTlv(discretionary);
  const passwordStatus = uniqueTag(attributes, 0xc4);
  if (!passwordStatus || passwordStatus.length !== 7 || passwordStatus[0]! > 1) {
    throw new Error('Invalid OpenPGP PW status');
  }
  const touchCache = requireSuccess(await exchange(transport, {
    cla: 0, ins: 0xca, p1: 1, p2: 2, le: 256,
  }, signal), 'Read OpenPGP touch cache policy');
  if (touchCache.length !== 1) throw new Error('Invalid OpenPGP touch cache policy');
  const slots: OpenPgpSlot[] = [];
  for (const [slot, attributeTag, uifTag, reference] of [
    ['SIG', 0xc1, 0xd6, 0xb6], ['AUT', 0xc3, 0xd8, 0xa4],
  ] as const) {
    const attribute = uniqueTag(attributes, attributeTag);
    const algorithmHex = attribute ? bytesToHex(attribute) : '';
    const algorithm = algorithmHex === algorithms.secp256k1 ? 'secp256k1'
      : algorithmHex === algorithms.ed25519 ? 'ed25519' : 'unsupported';
    const uif = uniqueTag(attributes, uifTag);
    if (!uif || uif.length !== 2 || uif[0]! > 2 || uif[1] !== 0x20) {
      throw new Error(`Invalid OpenPGP ${slot} touch policy`);
    }
    const response = await exchange(transport, {
      cla: 0, ins: 0x47, p1: 0x81, p2: 0, data: Uint8Array.of(reference, 0), le: 256,
    }, signal);
    let publicKeyHex = '';
    if (response.status !== 0x6a88) {
      const keyData = requireSuccess(response, `Read OpenPGP ${slot} public key`);
      const keyOuter = parseTlv(keyData);
      const template = uniqueTag(keyOuter, 0x7f49);
      if (keyOuter.length !== 1 || !template) throw new Error('Invalid OpenPGP public key template');
      const point = uniqueTag(parseTlv(template), 0x86);
      publicKeyHex = point ? bytesToHex(point) : '';
      if (algorithm !== 'unsupported') validatePublicKey(algorithm, publicKeyHex);
    }
    slots.push(Object.freeze({
      slot, algorithm: response.status === 0x6a88 ? 'missing' : algorithm,
      algorithmHex, publicKeyHex, uifHex: bytesToHex(uif),
    }));
  }
  const dec = uniqueTag(attributes, 0xc2);
  return Object.freeze({
    slots: Object.freeze(slots), passwordStatusHex: bytesToHex(passwordStatus),
    pw1Retries: passwordStatus[4]!, decAlgorithmHex: dec ? bytesToHex(dec) : '',
    touchCacheSeconds: touchCache[0]!,
  });
}

export async function discoverOpenPgp(transport: ApduTransport, signal?: AbortSignal): Promise<OpenPgpDiscovery> {
  if (activeTransports.has(transport) || batchTransports.has(transport)) throw new Error('OpenPGP transport already has an active operation');
  activeTransports.add(transport);
  try {
    return await readDiscovery(transport, signal);
  } finally {
    activeTransports.delete(transport);
  }
}

/** Only these fixed, domain-separated diagnostic messages can reach a device. */
export function prepareOpenPgpDiagnostic(
  slot: OpenPgpSlot,
  caseId: OpenPgpDiagnosticCase = 'basic',
): OpenPgpDiagnostic {
  if (slot.slot !== 'SIG' && slot.slot !== 'AUT') throw new Error('Unsupported OpenPGP signing slot');
  if (slot.algorithm !== 'secp256k1' && slot.algorithm !== 'ed25519') {
    throw new Error('OpenPGP slot has no supported signing key');
  }
  if (slot.algorithmHex !== algorithms[slot.algorithm]) throw new Error('OpenPGP algorithm attributes do not match');
  validatePublicKey(slot.algorithm, slot.publicKeyHex);
  const lengths = { basic: 0, 'length-255': 255, 'length-256': 256, 'length-1331': 1331 } as const;
  if (!Object.hasOwn(lengths, caseId)) throw new Error('Unsupported OpenPGP diagnostic case');
  if (slot.algorithm === 'secp256k1' && caseId !== 'basic') {
    throw new Error('ECDSA diagnostic supports only the fixed basic digest');
  }
  const prefix = new TextEncoder().encode(
    `CanoKeySigner P0 OpenPGP diagnostic v1\nslot=${slot.slot}\nalgorithm=${slot.algorithm}\ncase=${caseId}\nSynthetic test only.\n`,
  );
  const message = new Uint8Array(lengths[caseId] || prefix.length);
  message.fill(0x2e);
  message.set(prefix);
  const input = slot.algorithm === 'secp256k1' ? sha256(message) : message;
  const prepared = Object.freeze({
    slot: slot.slot, algorithm: slot.algorithm, algorithmHex: slot.algorithmHex,
    publicKeyHex: slot.publicKeyHex, uifHex: slot.uifHex, caseId,
    messageHex: bytesToHex(message), messageLength: message.length,
    inputHex: bytesToHex(input), inputLength: input.length,
  });
  preparedDiagnostics.add(prepared);
  return prepared;
}

async function clearPw1(transport: ApduTransport, signal: AbortSignal | undefined): Promise<boolean> {
  let cleared = true;
  try {
    for (const reference of [0x81, 0x82]) {
      const response = await exchange(transport, { cla: 0, ins: 0x20, p1: 0xff, p2: reference }, signal);
      if (response.status !== 0x9000 || response.data.length !== 0) cleared = false;
    }
    return cleared;
  } catch {
    return false;
  }
}

function checkApprovalDeadline(approval: TransactionApproval): void {
  if (Date.now() >= approval.expiresAt) throw new Error('签名批准已过期，请重新审查');
}

/** Consumes the prepared approval and PIN buffer once. A failed task is never retried. */
async function signPreparedInput<T extends Pick<OpenPgpDiagnostic, 'slot' | 'algorithm' | 'algorithmHex' | 'publicKeyHex' | 'uifHex' | 'inputHex'>>(
  transport: ApduTransport,
  prepared: T,
  pin: Uint8Array,
  signal: AbortSignal | undefined,
  authorize: () => void,
  options: { batch?: boolean; validate?: () => void } = {},
): Promise<T & { rawSignatureHex: string; signatureHex: string; verified: true; authenticationCleared: boolean }> {
  const pinBytes = Uint8Array.from(pin);
  pin.fill(0);
  let verificationAttempted = false;
  let authenticationCleared = false;
  let evidence: (T & { rawSignatureHex: string; signatureHex: string; verified: true }) | undefined;
  let failure: unknown;
  let failed = false;
  let ownsOperation = false;
  try {
    authorize();
    options.validate?.();
    if (activeTransports.has(transport) || (batchTransports.has(transport) && !options.batch)) throw new Error('OpenPGP transport already has an active operation');
    activeTransports.add(transport);
    ownsOperation = true;
    if (pinBytes.length < 6 || pinBytes.length > 64) throw new Error('OpenPGP PW1 must contain 6 to 64 bytes');
    const current = await readDiscovery(transport, signal);
    const slot = current.slots.find((item) => item.slot === prepared.slot);
    if (!slot || slot.algorithm !== prepared.algorithm || slot.algorithmHex !== prepared.algorithmHex
      || slot.publicKeyHex !== prepared.publicKeyHex || slot.uifHex !== prepared.uifHex) {
      throw new Error('OpenPGP slot, algorithm, public key or touch policy changed. Review again');
    }
    if (current.pw1Retries === 0) throw new Error('OpenPGP PW1 is blocked');
    options.validate?.();
    verificationAttempted = true;
    const reference = prepared.slot === 'SIG' ? 0x81 : 0x82;
    const verifiedPin = await exchange(transport, {
      cla: 0, ins: 0x20, p1: 0, p2: reference, data: pinBytes,
    }, signal);
    pinBytes.fill(0);
    requireSuccess(verifiedPin, 'Verify OpenPGP PW1');
    if (verifiedPin.data.length !== 0) throw new Error('Unexpected OpenPGP VERIFY response data');
    options.validate?.();
    const input = hexToBytes(prepared.inputHex);
    const signed = await exchange(transport, prepared.slot === 'SIG'
      ? { cla: 0, ins: 0x2a, p1: 0x9e, p2: 0x9a, data: input, le: 64 }
      : { cla: 0, ins: 0x88, p1: 0, p2: 0, data: input, le: 64 }, signal);
    const publicKey = hexToBytes(prepared.publicKeyHex);
    const signature = decodeAndVerifyDeviceSignature('openpgp', signed, prepared.algorithm === 'secp256k1'
      ? { kind: 'ecdsa-digest', digest: input, publicKey }
      : { kind: 'ed25519-message', message: input, publicKey });
    evidence = {
      ...prepared, rawSignatureHex: bytesToHex(signed.data), signatureHex: bytesToHex(signature), verified: true,
    };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    pinBytes.fill(0);
    pin.fill(0);
    if (verificationAttempted && !signal?.aborted) authenticationCleared = await clearPw1(transport, signal);
    if (ownsOperation) activeTransports.delete(transport);
  }
  if (signal?.aborted) throw new OpenPgpDiagnosticError('OpenPGP operation was cancelled', authenticationCleared);
  if (!failed) {
    try { options.validate?.(); }
    catch (error) { failed = true; failure = error; }
  }
  if (failed) {
    throw new OpenPgpDiagnosticError(failure instanceof Error ? failure.message : 'OpenPGP diagnostic failed', authenticationCleared);
  }
  if (!evidence) throw new OpenPgpDiagnosticError('OpenPGP diagnostic produced no evidence', authenticationCleared);
  return Object.freeze({ ...evidence, authenticationCleared });
}

export async function signOpenPgpDiagnostic(
  transport: ApduTransport, prepared: OpenPgpDiagnostic, pin: Uint8Array, signal?: AbortSignal,
): Promise<OpenPgpDiagnosticEvidence> {
  return signPreparedInput(transport, prepared, pin, signal, () => {
    if (!preparedDiagnostics.delete(prepared)) throw new Error('Diagnostic approval is invalid or already consumed');
  });
}

/** Transaction entry accepts only a live, single-use approval minted after review. */
export async function signOpenPgpEvmTransaction(
  transport: ApduTransport, approval: TransactionApproval, pin: Uint8Array, signal?: AbortSignal,
): Promise<{ signatureHex: string; authenticationCleared: boolean }> {
  try {
    const { review, slot } = consumeEvmApproval(approval);
    return await signPreparedInput(transport, {
      slot: slot.slot, algorithm: 'secp256k1', algorithmHex: slot.algorithmHex,
      publicKeyHex: slot.publicKeyHex, uifHex: slot.uifHex, inputHex: review.digestHex,
    }, pin, signal, () => undefined, { validate: () => {
      checkApprovalDeadline(approval); assertEvmReview(review);
    } });
  } finally { pin.fill(0); }
}

/** Message entry accepts only an independently reviewed, single-use message approval. */
export async function signOpenPgpEvmMessage(
  transport: ApduTransport, approval: EvmMessageApproval, pin: Uint8Array, signal?: AbortSignal,
): Promise<{ signatureHex: string; authenticationCleared: boolean }> {
  try {
    const { review, slot } = consumeEvmMessageApproval(approval);
    return await signPreparedInput(transport, {
      slot: slot.slot, algorithm: 'secp256k1', algorithmHex: slot.algorithmHex,
      publicKeyHex: slot.publicKeyHex, uifHex: slot.uifHex, inputHex: review.digestHex,
    }, pin, signal, () => undefined, { validate: () => {
      checkApprovalDeadline(approval); assertEvmMessageReview(review);
    } });
  } finally { pin.fill(0); }
}

/** Signs the complete displayed list of owned PSBT inputs, without retrying. */
export async function signOpenPgpBitcoinTransaction(
  transport: ApduTransport, approval: TransactionApproval, pin: Uint8Array, signal?: AbortSignal,
): Promise<{ psbt: Uint8Array; authenticationCleared: true }> {
  const pinBytes = Uint8Array.from(pin);
  pin.fill(0);
  let ownsBatch = false;
  try {
    if (activeTransports.has(transport) || batchTransports.has(transport)) throw new Error('设备已有活动任务');
    batchTransports.add(transport);
    ownsBatch = true;
    const { review, slot } = consumeBitcoinApproval(approval);
    const signatures: string[] = [];
    for (const job of review.jobs) {
      checkSignal(signal);
      checkApprovalDeadline(approval);
      const result = await signPreparedInput(transport, {
        slot: slot.slot, algorithm: 'secp256k1', algorithmHex: slot.algorithmHex,
        publicKeyHex: slot.publicKeyHex, uifHex: slot.uifHex, inputHex: job.digestHex,
      }, pinBytes.slice(), signal, () => undefined, { batch: true, validate: () => {
        checkApprovalDeadline(approval); assertBitcoinReview(review);
      } });
      if (!result.authenticationCleared) throw new OpenPgpDiagnosticError('PSBT 签名后认证清除失败，请拔插设备', false);
      signatures.push(result.signatureHex);
    }
    checkSignal(signal);
    checkApprovalDeadline(approval);
    return { psbt: attachBitcoinSignatures(review, signatures), authenticationCleared: true };
  } finally {
    pinBytes.fill(0);
    pin.fill(0);
    if (ownsBatch) batchTransports.delete(transport);
  }
}

/** Signs the exact protocol message, preserving all other signature slots. */
export async function signOpenPgpSolanaTransaction(
  transport: ApduTransport, approval: TransactionApproval, pin: Uint8Array, signal?: AbortSignal,
): Promise<{ transaction: Uint8Array; authenticationCleared: boolean }> {
  try {
    const { review, slot } = consumeSolanaApproval(approval);
    const result = await signPreparedInput(transport, {
      slot: slot.slot, algorithm: 'ed25519', algorithmHex: slot.algorithmHex,
      publicKeyHex: slot.publicKeyHex, uifHex: slot.uifHex, inputHex: review.messageHex,
    }, pin, signal, () => undefined, { validate: () => {
      checkApprovalDeadline(approval); assertSolanaReview(review);
    } });
    return { transaction: attachSolanaSignature(review, hexToBytes(result.signatureHex)), authenticationCleared: result.authenticationCleared };
  } finally { pin.fill(0); }
}

/** Independently approved off-chain messages share only the exact-byte Ed25519 device path. */
export async function signOpenPgpSolanaMessage(
  transport: ApduTransport, approval: SolanaMessageApproval, pin: Uint8Array, signal?: AbortSignal,
): Promise<{ signatureHex: string; authenticationCleared: boolean }> {
  try {
    const { review, slot } = consumeSolanaMessageApproval(approval);
    return await signPreparedInput(transport, {
      slot: slot.slot, algorithm: 'ed25519', algorithmHex: slot.algorithmHex,
      publicKeyHex: slot.publicKeyHex, uifHex: slot.uifHex, inputHex: review.messageHex,
    }, pin, signal, () => undefined, { validate: () => {
      checkApprovalDeadline(approval); assertSolanaMessageReview(review);
    } });
  } finally { pin.fill(0); }
}
