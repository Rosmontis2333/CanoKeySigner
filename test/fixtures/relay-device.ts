import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { ApduTransport } from '../../src/device/apdu';
import type { OpenPgpSlot } from '../../src/device/openpgp';
import type { DeviceAccess } from '../../src/signing/execute';
import { accountAddresses, accountChain } from '../../src/ui/accounts';
import type { WalletAccount } from '../../src/ui/accounts';
import { bitcoinSecret } from './bitcoin';
import { solanaSeed } from './solana';

function tlv(tag: number, data: Uint8Array): Uint8Array {
  return Uint8Array.from([...(tag > 255 ? [tag >> 8, tag & 255] : [tag]), 0x82, data.length >> 8, data.length & 255, ...data]);
}
function commandData(command: Uint8Array): Uint8Array {
  if (command.length <= 5) return new Uint8Array();
  const extended = command[4] === 0;
  const length = extended ? command[5]! * 256 + command[6]! : command[4]!;
  const start = extended ? 7 : 5;
  return command.slice(start, start + length);
}

/** Dedicated synthetic keys, isolated from USB and the user's PIN or keys. */
export function relayDevice(coin: 'evm' | 'solana') {
  const sig: OpenPgpSlot = { slot: 'SIG', algorithm: 'ed25519', algorithmHex: '162b06010401da470f01',
    publicKeyHex: bytesToHex(ed25519.getPublicKey(solanaSeed)), uifHex: '0020' };
  const aut: OpenPgpSlot = { slot: 'AUT', algorithm: 'secp256k1', algorithmHex: '132b8104000a',
    publicKeyHex: bytesToHex(secp256k1.getPublicKey(bitcoinSecret, false)), uifHex: '0120' };
  const slot = coin === 'evm' ? aut : sig;
  const network = coin === 'evm' ? '' : 'devnet';
  const account: WalletAccount = { coin, network, chainId: coin === 'evm' ? '' : accountChain(coin, network),
    slot, publicKeyHex: slot.publicKeyHex, address: accountAddresses(coin, slot, network)[0]!.address };
  let signatures = 0, tasks = 0, verifications = 0, cleanup = 0;
  let controller: AbortController | undefined;
  let blocked = false;
  const transport: ApduTransport = { async exchange(command) {
    const data = commandData(command);
    let result: Uint8Array = new Uint8Array();
    switch (command[1]) {
      case 0xa4:
        assert.equal(bytesToHex(data), 'd27600012401');
        break;
      case 0xca:
        if (command[2] === 1 && command[3] === 2) result = Uint8Array.of(0);
        else {
          assert.equal(command[2], 0); assert.equal(command[3], 0x6e);
          result = tlv(0x6e, tlv(0x73, Uint8Array.from([
            ...tlv(0xc1, hexToBytes(sig.algorithmHex)), ...tlv(0xc3, hexToBytes(aut.algorithmHex)),
            ...tlv(0xc4, Uint8Array.of(0, 64, 64, 64, 3, 3, 3)),
            ...tlv(0xd6, hexToBytes(sig.uifHex)), ...tlv(0xd8, hexToBytes(aut.uifHex)),
          ])));
        }
        break;
      case 0x47:
        assert.equal(command[2], 0x81);
        assert.ok(data[0] === 0xb6 || data[0] === 0xa4);
        result = tlv(0x7f49, tlv(0x86, hexToBytes(data[0] === 0xb6 ? sig.publicKeyHex : aut.publicKeyHex)));
        break;
      case 0x20:
        if (command[2] === 0xff) { assert.equal(data.length, 0); cleanup++; }
        else { assert.equal(new TextDecoder().decode(data), '123456'); verifications++; }
        break;
      case 0x2a:
        assert.equal(coin, 'solana'); signatures++;
        result = ed25519.sign(data, solanaSeed);
        break;
      case 0x88:
        assert.equal(coin, 'evm'); assert.equal(data.length, 32); signatures++;
        result = secp256k1.sign(data, bitcoinSecret, { prehash: false });
        break;
      default: throw new Error('Unexpected APDU in relay test');
    }
    data.fill(0);
    return Uint8Array.from([...result, 0x90, 0]);
  } };
  const access: DeviceAccess = {
    slots: () => [sig, aut], busy: () => !!controller || blocked,
    cancel: () => controller?.abort(), requireReinsert: () => { blocked = true; },
    async sign(operation) {
      if (controller || blocked) throw new Error('Simulated device is busy or blocked');
      const abort = new AbortController(); controller = abort; tasks++;
      try { return await operation(transport, abort.signal); } finally { controller = undefined; }
    },
  };
  return { account, access, counts: () => ({ signatures, tasks, verifications, cleanup, blocked }) };
}
