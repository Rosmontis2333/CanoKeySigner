import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram, AddressLookupTableAccount, TransactionInstruction } from '@solana/web3.js';
import { base58, base64 } from '@scure/base';
export const solanaSeed = new Uint8Array(32).fill(2);
export const solanaSigner = Keypair.fromSeed(solanaSeed);
export const solanaOther = Keypair.fromSeed(new Uint8Array(32).fill(3));
export const solanaDestination = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;
export const solanaBlockhash = base58.encode(new Uint8Array(32).fill(9));
export const lookupKey = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey;
export const mintKey = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey;
export function solanaFixture(v0 = false, multi = false, customInstructions?: TransactionInstruction[]) {
  const instructions = customInstructions ?? [SystemProgram.transfer({ fromPubkey: solanaSigner.publicKey, toPubkey: solanaDestination, lamports: 17n }),
    ...(multi ? [SystemProgram.transfer({ fromPubkey: solanaOther.publicKey, toPubkey: solanaDestination, lamports: 2n })] : [])];
  const table = new AddressLookupTableAccount({ key: lookupKey, state: {
    deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 10, lastExtendedSlotStartIndex: 0,
    addresses: [mintKey, solanaDestination],
  } });
  const builder = new TransactionMessage({ payerKey: solanaSigner.publicKey, recentBlockhash: solanaBlockhash, instructions });
  const message = v0 ? builder.compileToV0Message([table]) : builder.compileToLegacyMessage();
  const transaction = new VersionedTransaction(message);
  if (multi) transaction.sign([solanaOther]);
  const data = Buffer.alloc(56 + 64);
  data.writeUInt32LE(1, 0); data.writeBigUInt64LE(0xffffffffffffffffn, 4); data.writeBigUInt64LE(10n, 12);
  data.set(mintKey.toBytes(), 56); data.set(solanaDestination.toBytes(), 88);
  const snapshots = JSON.stringify([{ address: lookupKey.toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111',
    dataBase64: base64.encode(data), source: 'official-codec-test-fixture', contextSlot: '11', network: 'devnet' }]);
  return { transaction, message: message.serialize(), bytes: transaction.serialize(), snapshots, table };
}
export function tokenInstruction(type = 12): TransactionInstruction {
  const data = Buffer.alloc(10); data[0] = type; data.writeBigUInt64LE(123456789n, 1); data[9] = 6;
  return new TransactionInstruction({ programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data,
    keys: [
      { pubkey: solanaSigner.publicKey, isSigner: false, isWritable: true },
      { pubkey: mintKey, isSigner: false, isWritable: false },
      { pubkey: solanaDestination, isSigner: false, isWritable: true },
      { pubkey: solanaSigner.publicKey, isSigner: true, isWritable: false },
    ] });
}
