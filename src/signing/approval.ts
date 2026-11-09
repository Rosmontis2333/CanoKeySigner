import { assertSolanaReview } from '../chains/solana/transaction';
import type { SolanaReview } from '../chains/solana/transaction';
import { assertBitcoinReview } from '../chains/bitcoin/transaction';
import type { BitcoinReview } from '../chains/bitcoin/transaction';
import { assertEvmReview } from '../chains/evm/transaction';
import type { EvmReview } from '../chains/evm/transaction';
import type { OpenPgpSlot } from '../device/openpgp';
import { assertEvmMessageReview } from '../chains/evm/message';
import type { EvmMessageReview } from '../chains/evm/message';
import { assertSolanaMessageReview } from '../chains/solana/message';
import type { SolanaMessageReview } from '../chains/solana/message';

export interface TransactionApproval { readonly expiresAt: number }
const approvals = new WeakMap<TransactionApproval, { review: EvmReview; slot: OpenPgpSlot }>();

/** Called only after the user confirms the full displayed review. */
export function approveEvmTransaction(review: EvmReview, slot: OpenPgpSlot): TransactionApproval {
  assertEvmReview(review);
  if (slot.algorithm !== 'secp256k1' || slot.publicKeyHex !== review.publicKeyHex) throw new Error('交易账户与槽位公钥不匹配');
  const approval = Object.freeze({ expiresAt: Date.now() + 5 * 60_000 });
  approvals.set(approval, { review, slot: Object.freeze({ ...slot }) });
  return approval;
}

export function revokeTransactionApproval(approval: TransactionApproval): void { approvals.delete(approval); bitcoinApprovals.delete(approval); solanaApprovals.delete(approval); }

export function consumeEvmApproval(approval: TransactionApproval): { review: EvmReview; slot: OpenPgpSlot } {
  const captured = approvals.get(approval);
  approvals.delete(approval);
  if (!captured || Date.now() >= approval.expiresAt) throw new Error('交易批准已过期或失效，请重新审查');
  assertEvmReview(captured.review);
  return captured;
}

const bitcoinApprovals = new WeakMap<TransactionApproval, { review: BitcoinReview; slot: OpenPgpSlot }>();
export function approveBitcoinTransaction(review: BitcoinReview, slot: OpenPgpSlot): TransactionApproval {
  assertBitcoinReview(review);
  if (slot.algorithm !== 'secp256k1' || slot.publicKeyHex !== review.publicKeyHex) throw new Error('PSBT 公钥与槽位不匹配');
  const approval = Object.freeze({ expiresAt: Date.now() + 5 * 60_000 });
  bitcoinApprovals.set(approval, { review, slot: Object.freeze({ ...slot }) });
  return approval;
}
export function consumeBitcoinApproval(approval: TransactionApproval): { review: BitcoinReview; slot: OpenPgpSlot } {
  const captured = bitcoinApprovals.get(approval);
  bitcoinApprovals.delete(approval);
  if (!captured || Date.now() >= approval.expiresAt) throw new Error('PSBT 批准已过期或失效');
  assertBitcoinReview(captured.review);
  return captured;
}

const solanaApprovals = new WeakMap<TransactionApproval, { review: SolanaReview; slot: OpenPgpSlot }>();
export function approveSolanaTransaction(review: SolanaReview, slot: OpenPgpSlot): TransactionApproval {
  assertSolanaReview(review);
  if (slot.algorithm !== 'ed25519' || slot.publicKeyHex !== review.publicKeyHex) throw new Error('Solana signer 与 Ed25519 槽位不匹配');
  const approval = Object.freeze({ expiresAt: Date.now() + 5 * 60_000 });
  solanaApprovals.set(approval, { review, slot: Object.freeze({ ...slot }) });
  return approval;
}
export function consumeSolanaApproval(approval: TransactionApproval): { review: SolanaReview; slot: OpenPgpSlot } {
  const captured = solanaApprovals.get(approval);
  solanaApprovals.delete(approval);
  if (!captured || Date.now() >= approval.expiresAt) throw new Error('Solana 批准已过期或失效');
  assertSolanaReview(captured.review);
  return captured;
}

export interface EvmMessageApproval { readonly kind: 'evm-message'; readonly expiresAt: number }
const messageApprovals = new WeakMap<EvmMessageApproval, { review: EvmMessageReview; slot: OpenPgpSlot }>();
export function approveEvmMessage(review: EvmMessageReview, slot: OpenPgpSlot): EvmMessageApproval {
  assertEvmMessageReview(review);
  if (slot.algorithm !== 'secp256k1' || slot.publicKeyHex !== review.publicKeyHex) throw new Error('消息账户与槽位公钥不匹配');
  const approval: EvmMessageApproval = Object.freeze({ kind: 'evm-message', expiresAt: Date.now() + 5 * 60_000 });
  messageApprovals.set(approval, { review, slot: Object.freeze({ ...slot }) });
  return approval;
}
export function revokeEvmMessageApproval(approval: EvmMessageApproval): void { messageApprovals.delete(approval); }
export function consumeEvmMessageApproval(approval: EvmMessageApproval): { review: EvmMessageReview; slot: OpenPgpSlot } {
  const captured = messageApprovals.get(approval);
  messageApprovals.delete(approval);
  if (!captured || Date.now() >= approval.expiresAt) throw new Error('消息批准已过期或失效，请重新审查');
  assertEvmMessageReview(captured.review);
  return captured;
}

export interface SolanaMessageApproval { readonly kind: 'solana-message'; readonly expiresAt: number }
const solanaMessageApprovals = new WeakMap<SolanaMessageApproval, { review: SolanaMessageReview; slot: OpenPgpSlot }>();
export function approveSolanaMessage(review: SolanaMessageReview, slot: OpenPgpSlot): SolanaMessageApproval {
  assertSolanaMessageReview(review);
  if (slot.algorithm !== 'ed25519' || slot.publicKeyHex !== review.publicKeyHex) throw new Error('离链消息账户与 Ed25519 槽位公钥不匹配');
  const approval: SolanaMessageApproval = Object.freeze({ kind: 'solana-message', expiresAt: Date.now() + 5 * 60_000 });
  solanaMessageApprovals.set(approval, { review, slot: Object.freeze({ ...slot }) });
  return approval;
}
export function revokeSolanaMessageApproval(approval: SolanaMessageApproval): void { solanaMessageApprovals.delete(approval); }
export function consumeSolanaMessageApproval(approval: SolanaMessageApproval): { review: SolanaMessageReview; slot: OpenPgpSlot } {
  const captured = solanaMessageApprovals.get(approval);
  solanaMessageApprovals.delete(approval);
  if (!captured || Date.now() >= approval.expiresAt) throw new Error('离链消息批准已过期或失效，请重新审查');
  assertSolanaMessageReview(captured.review);
  return captured;
}
