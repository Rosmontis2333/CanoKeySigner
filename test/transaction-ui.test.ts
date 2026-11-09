import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { mountTransactionApp } from '../src/ui/transaction';
import type { DeviceAccess } from '../src/signing/execute';
import { bitcoinFixture, bitcoinPublic } from './fixtures/bitcoin';
import { solanaFixture, solanaSigner } from './fixtures/solana';
import { etherMail } from './fixtures/evm-message';

class Element extends EventTarget {
  value = ''; textContent = ''; disabled = false; hidden = false; checked = false;
  options: Element[] = [];
  constructor(readonly tag = '') { super(); }
  replaceChildren() { this.options = []; if (this.tag === 'select') this.value = ''; }
  append(...elements: Element[]) {
    this.options.push(...elements);
    if (this.tag === 'select' && !this.value) this.value = elements[0]?.value ?? '';
  }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function fixture(context: TestContext, chain: 'evm' | 'bitcoin' | 'solana') {
  const elements = new Map<string, Element>();
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2]!, new Element(match[1]));
  const replacements = { document: { getElementById: (id: string) => elements.get(id) ?? null, createElement: (tag: string) => new Element(tag) },
    __WALLETCONNECT__: false, __EVM_RPC_ENDPOINTS__: [], __SOLANA_RPC_ENDPOINTS__: [] };
  for (const [name, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    context.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  const prefix = chain === 'evm' ? 'transaction' : chain;
  const get = (name: string) => elements.get(`${prefix}-${name}`)!;
  if (chain !== 'evm') { get('network').value = chain === 'solana' ? 'mainnet-beta' : 'mainnet'; get('encoding').value = 'base64'; }
  const key = { slot: 'SIG', algorithm: chain === 'solana' ? 'ed25519' : 'secp256k1', algorithmHex: '',
    publicKeyHex: bytesToHex(chain === 'solana' ? solanaSigner.publicKey.toBytes() : bitcoinPublic), uifHex: '0120' } as const;
  const access: DeviceAccess = { slots: () => [key], busy: () => false, cancel() {}, requireReinsert() {},
    async sign() { throw new Error('UI review tests must not access hardware'); } };
  const app = mountTransactionApp(access, chain);
  return { app, get };
}

for (const chain of ['evm', 'bitcoin', 'solana'] as const) test(`${chain} normal review enables direct signing and input changes invalidate approval`, (context) => {
  const { app, get } = fixture(context, chain);
  const sources = chain === 'evm' ? ['Sign in to example.org with nonce 123', JSON.stringify(etherMail)]
    : chain === 'bitcoin' ? [base64.encode(bitcoinFixture())]
      : [base64.encode(solanaFixture().bytes), base64.encode(solanaFixture().message), 'Sign in to example.org with nonce 123'];
  for (const source of sources) {
    get('source').value = source; app.refresh(); get('parse').click();
    assert.equal(get('approval').hidden, false, get('status').textContent);
    assert.equal(get('sign').disabled, false);
    assert.ok(get('review').options.length > 0);
    get('pin').value = 'synthetic-unused-pin';
    get('source').dispatchEvent(new Event('input'));
    assert.equal(get('sign').disabled, true);
    assert.equal(get('approval').hidden, true);
    assert.equal(get('pin').value, '');
  }
});
