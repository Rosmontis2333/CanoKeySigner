import { base58 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p2pkh, p2sh, p2wpkh, NETWORK, TEST_NETWORK } from '@scure/btc-signer';
import { addr } from 'micro-eth-signer';
import type { OpenPgpSlot } from '../device/openpgp';
export type Coin = 'evm' | 'bitcoin' | 'solana';
// EVM network/chainId are empty until a transaction or connection proposal supplies the chain.
export interface WalletAccount { coin: Coin; network: string; chainId: string; address: string; publicKeyHex: string; slot: OpenPgpSlot }
export function accountAddresses(coin: Coin, key: OpenPgpSlot, network: string): readonly { label: string; address: string }[] {
  if (key.algorithm !== (coin === 'solana' ? 'ed25519' : 'secp256k1')) return [];
  const publicKey = hexToBytes(key.publicKeyHex);
  if (coin === 'evm') return [{ label: 'EVM 地址', address: addr.fromPublicKey(publicKey) }];
  if (coin === 'solana') return [{ label: 'Solana 地址', address: base58.encode(publicKey) }];
  const point = secp256k1.Point.fromBytes(publicKey);
  const selectedNetwork = network === 'mainnet' ? NETWORK : TEST_NETWORK;
  const native = p2wpkh(point.toBytes(true), selectedNetwork);
  return [{ label: 'Native SegWit · P2WPKH', address: native.address! },
    { label: 'Wrapped SegWit · P2SH-P2WPKH', address: p2sh(native, selectedNetwork).address! },
    { label: 'Legacy · P2PKH（压缩公钥）', address: p2pkh(point.toBytes(true), selectedNetwork).address! },
    { label: 'Legacy · P2PKH（未压缩公钥）', address: p2pkh(point.toBytes(false), selectedNetwork).address! }];
}
export function accountChain(coin: Coin, network: string): string {
  if (coin === 'evm') {
    if (!/^[1-9][0-9]*$/.test(network) || BigInt(network) >= 1n << 256n) throw new Error('chainId 需要正整数字符串');
    return `eip155:${network}`;
  }
  if (coin === 'bitcoin' && !['mainnet', 'testnet'].includes(network)) throw new Error('Bitcoin 网络无效');
  if (coin === 'bitcoin') return `bip122:${network === 'mainnet' ? '000000000019d6689c085ae165831e93' : '000000000933ea01ad0ee984209779ba'}`;
  const clusters: Record<string, string> = { 'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1', testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z' };
  if (!clusters[network]) throw new Error('Solana cluster 无效');
  return `solana:${clusters[network]}`;
}
