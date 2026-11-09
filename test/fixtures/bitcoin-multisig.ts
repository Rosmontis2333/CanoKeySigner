import { Psbt, Transaction, payments, networks } from 'bitcoinjs-lib';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Transaction as ScureTransaction } from '@scure/btc-signer';
import { bitcoinSecret } from './bitcoin';

export type BitcoinTemplate = 'pkh' | 'uncompressed-pkh' | 'sh-ms' | 'uncompressed-sh-ms' | 'wsh-ms' | 'sh-wsh-ms';
export const bitcoinTemplates: BitcoinTemplate[] = ['pkh', 'uncompressed-pkh', 'sh-ms', 'uncompressed-sh-ms', 'wsh-ms', 'sh-wsh-ms'];
export const cosignerSecret = new Uint8Array(32).fill(3);
export const thirdSecret = new Uint8Array(32).fill(4);
const network = networks.testnet;

export function bitcoinTemplatePayment(template: BitcoinTemplate, threshold = 2) {
  const compressed = !template.startsWith('uncompressed');
  const keys = [bitcoinSecret, cosignerSecret, thirdSecret].map((secret) => secp256k1.getPublicKey(secret, compressed));
  if (template.endsWith('pkh')) return { payment: payments.p2pkh({ pubkey: keys[0]!, network }), keys };
  const multisig = payments.p2ms({ m: threshold, pubkeys: keys, network });
  const payment = template === 'sh-ms' || template === 'uncompressed-sh-ms' ? payments.p2sh({ redeem: multisig, network })
    : template === 'wsh-ms' ? payments.p2wsh({ redeem: multisig, network })
    : payments.p2sh({ redeem: payments.p2wsh({ redeem: multisig, network }), network });
  return { payment, keys };
}

/** Constructed and cosigned by the independent bitcoinjs PSBT implementation. */
export function bitcoinTemplateFixture(templates: BitcoinTemplate[] = ['wsh-ms'], version: 0 | 2 = 0, cosign = true, threshold = 2) {
  const previous = new Transaction();
  previous.version = 2;
  previous.addInput(new Uint8Array(32).fill(0x42), 0);
  const descriptors = templates.map((template) => bitcoinTemplatePayment(template, threshold));
  for (const { payment } of descriptors) previous.addOutput(payment.output!, 100000n);
  const psbt = new Psbt({ network });
  psbt.setVersion(2); psbt.setLocktime(123);
  descriptors.forEach(({ payment }, index) => {
    const template = templates[index]!;
    const wrappedWitness = template === 'sh-wsh-ms';
    psbt.addInput({ hash: previous.getId(), index, sequence: 0xfffffffd, nonWitnessUtxo: previous.toBuffer(),
      witnessUtxo: { script: payment.output!, value: 100000n },
      ...(template !== 'wsh-ms' && payment.redeem?.output ? { redeemScript: payment.redeem.output } : {}),
      ...(template === 'wsh-ms' ? { witnessScript: payment.redeem!.output! }
        : wrappedWitness ? { witnessScript: payment.redeem!.redeem!.output! } : {}) });
  });
  const output = payments.p2pkh({ pubkey: secp256k1.getPublicKey(bitcoinSecret), network });
  psbt.addOutput({ script: output.output!, value: BigInt(templates.length) * 100000n - 1000n });
  if (cosign) templates.forEach((template, index) => {
    if (template.endsWith('pkh')) return;
    psbt.signInput(index, { publicKey: secp256k1.getPublicKey(cosignerSecret, !template.startsWith('uncompressed')),
      sign: (digest) => secp256k1.sign(digest, cosignerSecret, { prehash: false }) });
  });
  psbt.addUnknownKeyValToGlobal({ key: Uint8Array.of(0xfa, 1), value: Uint8Array.of(7, 8) });
  psbt.addUnknownKeyValToInput(0, { key: Uint8Array.of(0xfa, 2), value: Uint8Array.of(3) });
  const v0 = psbt.toBuffer();
  const bytes = version === 0 ? v0 : ScureTransaction.fromPSBT(v0, { unknown: 'ignore', proprietary: 'ignore' }).toPSBT(2);
  return { bytes, v0, psbt, previous, descriptors };
}
