import { base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';
import { attachEvmTransaction } from '../chains/evm/transaction';
import type { EvmReview } from '../chains/evm/transaction';
import type { BitcoinReview } from '../chains/bitcoin/transaction';
import type { SolanaReview } from '../chains/solana/transaction';
import { approveBitcoinTransaction, approveEvmTransaction, approveSolanaTransaction, revokeTransactionApproval, approveEvmMessage, revokeEvmMessageApproval, approveSolanaMessage, revokeSolanaMessageApproval } from './approval';
import { signOpenPgpBitcoinTransaction, signOpenPgpEvmTransaction, signOpenPgpSolanaTransaction, signOpenPgpEvmMessage, signOpenPgpSolanaMessage } from '../device/openpgp';
import type { OpenPgpSlot } from '../device/openpgp';
import type { ApduTransport } from '../device/apdu';
import { attachEvmMessageSignature } from '../chains/evm/message';
import type { EvmMessageReview } from '../chains/evm/message';
import { verifySolanaMessageSignature } from '../chains/solana/message';
import type { SolanaMessageReview } from '../chains/solana/message';
export type Review = EvmReview | BitcoinReview | SolanaReview | EvmMessageReview | SolanaMessageReview;
export interface DeviceAccess {
  slots(): readonly OpenPgpSlot[];
  selectedSlot?(chain: Review['chain']): string | undefined;
  busy(): boolean;
  sign<T>(operation: (transport: ApduTransport, signal: AbortSignal) => Promise<T>): Promise<T>;
  requireReinsert(): void;
  cancel(): void;
}
export async function executeReviewedTransaction(access: DeviceAccess, review: Review, slot: OpenPgpSlot, pin: Uint8Array): Promise<{ output: string; authenticationCleared: boolean }> {
  if ('kind' in review && review.kind === 'solana-message') {
    let approval: ReturnType<typeof approveSolanaMessage> | undefined;
    try {
      approval = approveSolanaMessage(review, slot);
      const authorized = approval;
      return await access.sign(async (transport, signal) => {
        const signed = await signOpenPgpSolanaMessage(transport, authorized, pin, signal);
        return { output: base64.encode(verifySolanaMessageSignature(review, hexToBytes(signed.signatureHex))), authenticationCleared: signed.authenticationCleared };
      });
    } finally { pin.fill(0); if (approval) revokeSolanaMessageApproval(approval); }
  }
  if ('kind' in review) {
    let approval: ReturnType<typeof approveEvmMessage> | undefined;
    try {
      approval = approveEvmMessage(review, slot);
      const authorized = approval;
      return await access.sign(async (transport, signal) => {
        const signed = await signOpenPgpEvmMessage(transport, authorized, pin, signal);
        return { output: attachEvmMessageSignature(review, hexToBytes(signed.signatureHex)), authenticationCleared: signed.authenticationCleared };
      });
    } finally { pin.fill(0); if (approval) revokeEvmMessageApproval(approval); }
  }
  let approval: ReturnType<typeof approveEvmTransaction> | undefined;
  try {
    approval = review.chain === 'evm' ? approveEvmTransaction(review, slot)
    : review.chain === 'bitcoin' ? approveBitcoinTransaction(review, slot) : approveSolanaTransaction(review, slot);
    const authorized = approval;
    return await access.sign(async (transport, signal) => {
      if (review.chain === 'evm') {
        const signed = await signOpenPgpEvmTransaction(transport, authorized, pin, signal);
        return { output: attachEvmTransaction(review, hexToBytes(signed.signatureHex)), authenticationCleared: signed.authenticationCleared };
      }
      if (review.chain === 'bitcoin') {
        const signed = await signOpenPgpBitcoinTransaction(transport, authorized, pin, signal);
        return { output: base64.encode(signed.psbt), authenticationCleared: signed.authenticationCleared };
      }
      const signed = await signOpenPgpSolanaTransaction(transport, authorized, pin, signal);
      return { output: base64.encode(signed.transaction), authenticationCleared: signed.authenticationCleared };
    });
  } finally { pin.fill(0); if (approval) revokeTransactionApproval(approval); }
}
