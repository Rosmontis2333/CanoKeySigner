import { solanaSigner } from './solana';

/** Independent fixed-layout serialization from the public off-chain message specification. */
export function offchainMessageFixture(options: {
  version?: 0 | 1; text?: string; signers?: Uint8Array[]; format?: number;
} = {}): Uint8Array {
  const version = options.version ?? 1;
  const signers = options.signers ?? [solanaSigner.publicKey.toBytes()];
  const content = Buffer.from(options.text ?? 'example.org\nSign in with this Solana account.\nNonce: synthetic123\n用途：测试', 'utf8');
  const domain = Buffer.concat([Buffer.from([255]), Buffer.from('solana offchain', 'ascii')]);
  if (version === 1) return Buffer.concat([domain, Buffer.from([1, signers.length]), ...signers, content]);
  const length = Buffer.alloc(2); length.writeUInt16LE(content.length);
  return Buffer.concat([domain, Buffer.from([0]), Buffer.alloc(32, 9), Buffer.from([options.format ?? 1, signers.length]), ...signers, length, content]);
}
