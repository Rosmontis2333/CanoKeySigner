import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p2sh, p2wpkh, Transaction } from '@scure/btc-signer';
import { RawPSBTV0 } from '@scure/btc-signer/psbt.js';
export const bitcoinSecret = new Uint8Array(32).fill(1);
export const bitcoinPublic = secp256k1.getPublicKey(bitcoinSecret, false);
const compressed = secp256k1.getPublicKey(bitcoinSecret);
const otherSecret = new Uint8Array(32).fill(3);
const otherPublic = secp256k1.getPublicKey(otherSecret);
export function bitcoinFixture(wrapped = false, ownInputs = 1, outputScript?: Uint8Array) {
  const native = p2wpkh(compressed);
  const payment = wrapped ? p2sh(native) : native;
  const previous = new Transaction();
  previous.addInput({ txid: new Uint8Array(32).fill(0x42), index: 0 });
  for (let i = 0; i < ownInputs; i++) previous.addOutput({ script: payment.script, amount: 50_000n });
  previous.addOutput({ script: p2wpkh(otherPublic).script, amount: 50_000n });
  const transaction = new Transaction({ unknown: 'ignore', proprietary: 'ignore', lockTime: 123 });
  for (let i = 0; i <= ownInputs; i++) {
    const own = i < ownInputs;
    const script = own ? payment.script : p2wpkh(otherPublic).script;
    transaction.addInput({ txid: previous.id, index: i, sequence: 0xfffffffd,
      nonWitnessUtxo: previous.toBytes(false, false), witnessUtxo: { script, amount: 50_000n },
      ...(own && wrapped ? { redeemScript: native.script } : {}) });
  }
  transaction.addOutput({ script: outputScript ?? p2wpkh(otherPublic).script, amount: BigInt(ownInputs + 1) * 50_000n - 1000n });
  transaction.signIdx(otherSecret, ownInputs);
  const raw = RawPSBTV0.decode(transaction.toPSBT(0));
  raw.global.unknown = [[{ type: 0xfa, key: new Uint8Array([1]) }, new Uint8Array([7, 8])]];
  raw.inputs[0]!.unknown = [[{ type: 0xfa, key: new Uint8Array([2]) }, new Uint8Array([3])]];
  return RawPSBTV0.encode(raw);
}

export function bitcoinV2Fixture(wrapped = false, ownInputs = 1): Uint8Array {
  return Transaction.fromPSBT(bitcoinFixture(wrapped, ownInputs), { unknown: 'ignore', proprietary: 'ignore' }).toPSBT(2);
}
