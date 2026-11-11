import { isConformingNamespaces } from '@walletconnect/utils';
import assert from 'node:assert/strict';
import test from 'node:test';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { accountAddresses, accountChain } from '../src/ui/accounts';
import type { WalletAccount } from '../src/ui/accounts';
import { sessionNamespaces, reviewWalletRequest, reviewWalletBatchRequest, accountForWalletRequest, walletMethods, SOLANA_BATCH_LIMIT } from '../src/connectors/walletconnect/policy';
import { bitcoinPublic } from './fixtures/bitcoin';
import { solanaFixture, solanaSigner } from './fixtures/solana';
import { tokenCallVectors, encodeTokenCall, tokenTransactionInput } from './fixtures/evm-calldata';
import { offchainMessageFixture } from './fixtures/solana-message';
import { base58 } from '@scure/base';
import { TransactionInstruction } from '@solana/web3.js';
import { solanaOther } from './fixtures/solana';

function account(coin: WalletAccount['coin']): WalletAccount {
  const network = coin === 'evm' ? '31337' : coin === 'bitcoin' ? 'testnet' : 'devnet';
  const publicKeyHex = coin === 'solana' ? bytesToHex(solanaSigner.publicKey.toBytes()) : bytesToHex(bitcoinPublic);
  const slot = { slot: 'AUT', algorithm: coin === 'solana' ? 'ed25519' : 'secp256k1', algorithmHex: coin === 'solana' ? '162b06010401da470f01' : '132b8104000a', publicKeyHex, uifHex: '0120' } as const;
  return { coin, network, slot, publicKeyHex, chainId: accountChain(coin, network), address: accountAddresses(coin, slot, network)[0]!.address };
}

test('coin account selector derives algorithm-compatible existing addresses', () => {
  const btc = account('bitcoin'), sol = account('solana');
  const addresses = accountAddresses('bitcoin', btc.slot, 'testnet');
  assert.equal(addresses.length, 4);
  assert.ok(addresses[0]!.address.startsWith('tb1'));
  assert.ok(addresses[1]!.address.startsWith('2'));
  assert.equal(accountAddresses('bitcoin', sol.slot, 'testnet').length, 0);
  assert.equal(accountAddresses('solana', btc.slot, 'devnet').length, 0);
  assert.equal(sol.address, solanaSigner.publicKey.toBase58());
  assert.throws(() => accountChain('evm', '01'));
});

test('WalletConnect required namespaces fail closed and optional capabilities grant only implemented methods', () => {
  const current = account('evm');
  const proposed = { requiredNamespaces: { eip155: { chains: [current.chainId], methods: ['eth_signTransaction'], events: [] } }, optionalNamespaces: {} };
  const granted = sessionNamespaces(proposed, current);
  assert.deepEqual(granted.eip155!.accounts, [`${current.chainId}:${current.address}`]);
  for (const request of [
    { ...proposed, requiredNamespaces: { eip155: { chains: ['eip155:1'], methods: ['eth_signTransaction'], events: [] } } },
    { ...proposed, requiredNamespaces: { eip155: { chains: [current.chainId], methods: ['wallet_sendCalls'], events: [] } } },
    { ...proposed, requiredNamespaces: { eip155: { chains: [current.chainId], methods: ['eth_signTransaction'], events: ['unsupportedEvent'] } } },
  ]) assert.throws(() => sessionNamespaces(request, current));
  const optional = sessionNamespaces({ requiredNamespaces: {}, optionalNamespaces: { eip155: { chains: [current.chainId], methods: ['eth_signTransaction', 'eth_sign'], events: [] } } }, current);
  assert.deepEqual(optional.eip155!.methods, ['eth_signTransaction']);
});

test('WalletConnect EVM normalizes RPC gas once and requires the authorized sender and explicit network', () => {
  const current = account('evm');
  const tx = { from: current.address, type: '0x2', chainId: '0x7a69', nonce: '0x0', gas: '0x5208', to: '0x0000000000000000000000000000000000000001', value: '0x0', data: '0x', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', accessList: [] };
  assert.equal(reviewWalletRequest(current, 'eth_signTransaction', [tx], '[]').signable, true);
  assert.throws(() => reviewWalletRequest(current, 'eth_signTransaction', [{ ...tx, gasLimit: '21000' }], '[]'));
  assert.throws(() => reviewWalletRequest(current, 'eth_signTransaction', [{ ...tx, from: tx.to }], '[]'));
  assert.throws(() => reviewWalletRequest(current, 'eth_signTransaction', [{ ...tx, chainId: '0x1' }], '[]'));
  assert.throws(() => reviewWalletRequest(current, 'eth_sign', [tx], '[]'));
  for (const fields of [{ type: '4' }, { type: '0x4' }, { authorizationList: [] }]) {
    assert.throws(() => reviewWalletRequest(current, 'eth_signTransaction', [{ ...tx, ...fields }], '[]'));
  }
  for (const method of ['wallet_signAuthorization', 'eth_signAuthorization']) {
    assert.throws(() => reviewWalletRequest(current, method, {}, '[]'));
    assert.throws(() => sessionNamespaces({ requiredNamespaces: { eip155: { chains: [current.chainId], methods: [method], events: [] } }, optionalNamespaces: {} }, current));
  }
});

test('Bitcoin has no WalletConnect capabilities and rejects namespace, account and signing requests', () => {
  const current = account('bitcoin');
  const namespaces = { bip122: { chains: [current.chainId], accounts: [`${current.chainId}:${current.address}`], methods: ['getAccountAddresses', 'signPsbt'], events: [] } };
  const proposal = { requiredNamespaces: { bip122: { chains: [current.chainId], methods: ['signPsbt'], events: [] } }, optionalNamespaces: {} };
  assert.deepEqual(walletMethods.bitcoin, []);
  assert.throws(() => sessionNamespaces(proposal, current), /手动签名/);
  assert.throws(() => accountForWalletRequest(current, namespaces, current.chainId, 'signPsbt'), /手动签名/);
  for (const method of ['getAccountAddresses', 'signPsbt']) assert.throws(() => reviewWalletRequest(current, method, {}, '[]'), /手动签名/);
  for (const coin of ['evm', 'solana'] as const) assert.throws(() => sessionNamespaces(proposal, account(coin)));
});

test('WalletConnect Solana requires serialized transaction and preserves the canonical review', () => {
  const current = account('solana');
  const request = { transaction: base64.encode(solanaFixture().bytes), pubkey: current.address };
  assert.equal(reviewWalletRequest(current, 'solana_signTransaction', request, '[]').signable, true);
  assert.throws(() => reviewWalletRequest(current, 'solana_signTransaction', { ...request, instructions: [] }, '[]'));
  assert.throws(() => reviewWalletRequest(current, 'solana_signTransaction', { ...request, pubkey: 'different' }, '[]'));
});

test('Solana batches preflight the complete ordered list, including ALT and existing signatures', () => {
  const current = account('solana');
  const fixtures = [solanaFixture(false, true), solanaFixture(true, true)];
  const transactions = fixtures.map((item) => base64.encode(item.bytes));
  const reviews = reviewWalletBatchRequest(current, { transactions }, fixtures[1]!.snapshots);
  assert.ok(Object.isFrozen(reviews));
  reviews.forEach((review, index) => {
    assert.equal(review.messageHex, bytesToHex(fixtures[index]!.message));
    assert.equal(review.transactionHex, bytesToHex(fixtures[index]!.bytes));
    assert.equal(review.signable, true);
    assert.ok(Object.isFrozen(review));
  });
  assert.equal(reviewWalletBatchRequest(current, { transactions: Array(SOLANA_BATCH_LIMIT).fill(transactions[0]) }, '[]').length, 8);
  const granted = sessionNamespaces({ requiredNamespaces: { solana: { chains: [current.chainId], methods: ['solana_signAllTransactions'], events: [] } }, optionalNamespaces: {} }, current);
  assert.equal(accountForWalletRequest(current, granted, current.chainId, 'solana_signAllTransactions'), current);
});

test('Solana batches reject bounds, malformed items, missing context and any later unreviewable transaction', () => {
  const current = account('solana'), valid = base64.encode(solanaFixture().bytes);
  const unknown = solanaFixture(false, false, [new TransactionInstruction({ programId: solanaOther.publicKey, keys: [], data: Buffer.of(1) })]);
  const alreadySigned = solanaFixture(); alreadySigned.transaction.sign([solanaSigner]);
  for (const params of [null, [], {}, { transactions: [] }, { transactions: Array(9).fill(valid) },
    { transactions: [valid], pubkey: current.address }, { transactions: [valid, 1] }, { transactions: [valid, 'A'.repeat(1645)] },
    { transactions: [valid, 'invalid'] }, { transactions: [valid, base64.encode(solanaFixture(true).bytes)] },
    { transactions: [valid, base64.encode(unknown.bytes)] }, { transactions: [valid, base64.encode(alreadySigned.transaction.serialize())] }]) {
    assert.throws(() => reviewWalletBatchRequest(current, params, '[]'));
  }
  for (const coin of ['evm', 'bitcoin'] as const) assert.throws(() => reviewWalletBatchRequest(account(coin), { transactions: [valid] }, '[]'));
  const foreign = { ...current, publicKeyHex: bytesToHex(solanaOther.publicKey.toBytes()) };
  assert.throws(() => reviewWalletBatchRequest(foreign, { transactions: [valid] }, '[]'));
});

test('WalletConnect Solana message grants bind exact Base58 offchain bytes and required account', () => {
  const current = account('solana');
  const granted = sessionNamespaces({ requiredNamespaces: { solana: { chains: [current.chainId], methods: ['solana_signMessage'], events: [] } }, optionalNamespaces: {} }, current);
  assert.deepEqual(granted.solana!.methods, ['solana_signMessage']);
  for (const version of [0, 1] as const) {
    const bytes = offchainMessageFixture({ version });
    const params = { message: base58.encode(bytes), pubkey: current.address };
    const review = reviewWalletRequest(current, 'solana_signMessage', params, '[]');
    assert.equal(review.signable, true);
    assert.ok('kind' in review && review.kind === 'solana-message');
    assert.equal(review.messageHex, bytesToHex(bytes));
    for (const invalid of [{ ...params, pubkey: 'other' }, { message: params.message }, { ...params, extra: true },
      { ...params, message: 'raw text' }, { ...params, message: base58.encode(solanaFixture().message) },
      { ...params, message: base64.encode(bytes) }]) {
      assert.throws(() => reviewWalletRequest(current, 'solana_signMessage', invalid, '[]'));
    }
  }
});

test('WalletConnect token calls retain full standard ABI review and reject malformed or wrong-chain requests', () => {
  const current = account('evm');
  for (const vector of tokenCallVectors) {
    const data = encodeTokenCall(vector.signature, vector.args);
    const tx = { ...tokenTransactionInput(data), from: current.address };
    const review = reviewWalletRequest(current, 'eth_signTransaction', [tx], '[]');
    assert.equal(review.signable, true);
    assert.ok(review.rows.some(([label, value]) => label === '函数签名（ABI 匹配）' && value === vector.signature));
    assert.throws(() => reviewWalletRequest(current, 'eth_signTransaction', [{ ...tx, chainId: '1' }], '[]'));
    assert.equal(reviewWalletRequest(current, 'eth_signTransaction', [{ ...tx, data: data + '00' }], '[]').signable, false);
  }
});

test('WalletConnect grants and reviews only account-bound readable personal and chain-bound typed messages', () => {
  const current = account('evm');
  const granted = sessionNamespaces({ requiredNamespaces: { eip155: { chains: [current.chainId], methods: ['personal_sign', 'eth_signTypedData_v4'], events: [] } }, optionalNamespaces: {} }, current);
  assert.deepEqual(granted.eip155!.methods, ['personal_sign', 'eth_signTypedData_v4']);
  const personal = reviewWalletRequest(current, 'personal_sign', ['0x6869', current.address], '[]');
  assert.ok('kind' in personal && personal.kind === 'message');
  assert.ok('content' in personal && personal.content === '6869');
  assert.throws(() => reviewWalletRequest(current, 'personal_sign', [current.address, '0x6869'], '[]'));
  assert.throws(() => reviewWalletRequest(current, 'personal_sign', ['hi', current.address], '[]'));
  assert.throws(() => reviewWalletRequest(current, 'personal_sign', ['0x6869', current.address, true], '[]'));
  assert.throws(() => reviewWalletRequest(current, 'eth_sign', [current.address, '0x' + '11'.repeat(32)], '[]'));
  const typed = { types: { Test: [{ name: 'purpose', type: 'string' }] }, primaryType: 'Test', domain: { chainId: current.network }, message: { purpose: 'test' } };
  for (const source of [typed, JSON.stringify(typed)]) {
    const reviewed = reviewWalletRequest(current, 'eth_signTypedData_v4', [current.address, source], '[]');
    assert.ok('kind' in reviewed && reviewed.method === 'eth_signTypedData_v4');
  }
  assert.throws(() => reviewWalletRequest(current, 'eth_signTypedData_v4', [current.address, { ...typed, domain: { chainId: '1' } }], '[]'));
});

test('automatic EVM accounts take chains from proposals and bind each request to its exact approved namespace', () => {
  const current = { ...account('evm'), chainId: '', network: '' };
  const granted = sessionNamespaces({
    requiredNamespaces: { eip155: { chains: ['eip155:1'], methods: ['eth_signTransaction'], events: [] } },
    optionalNamespaces: { eip155: { chains: ['eip155:8453'], methods: ['personal_sign', 'eth_sign'], events: [] } },
  }, current);
  assert.deepEqual(granted.eip155!.chains, ['eip155:1', 'eip155:8453']);
  assert.deepEqual(granted.eip155!.methods, ['eth_signTransaction', 'personal_sign']);
  assert.deepEqual(granted.eip155!.accounts, [`eip155:1:${current.address}`, `eip155:8453:${current.address}`]);
  const bound = accountForWalletRequest(current, granted, 'eip155:8453', 'eth_signTransaction');
  assert.equal(bound.network, '8453'); assert.equal(bound.chainId, 'eip155:8453');
  assert.throws(() => accountForWalletRequest(current, granted, 'eip155:137', 'personal_sign'));
  assert.throws(() => accountForWalletRequest(current, granted, 'eip155:1', 'eth_sign'));
  for (const chain of ['eip155:0', 'eip155:01', 'eip155:0x1', 'solana:1', 'eip155:' + '1'.repeat(33)]) {
    assert.throws(() => sessionNamespaces({ requiredNamespaces: { eip155: { chains: [chain], methods: ['personal_sign'], events: [] } }, optionalNamespaces: {} }, current));
  }
  const qualified = sessionNamespaces({ requiredNamespaces: {
    'eip155:1': { methods: ['eth_signTransaction'], events: [] },
    'eip155:8453': { methods: ['personal_sign'], events: [] },
  }, optionalNamespaces: {} }, current);
  assert.equal(accountForWalletRequest(current, qualified, 'eip155:1', 'eth_signTransaction').network, '1');
  assert.throws(() => accountForWalletRequest(current, qualified, 'eip155:1', 'personal_sign'));
  assert.throws(() => accountForWalletRequest(current, qualified, 'eip155:8453', 'eth_signTransaction'));
  assert.throws(() => sessionNamespaces({ requiredNamespaces: { 'eip155:1': { chains: ['eip155:8453'], methods: ['personal_sign'], events: [] } }, optionalNamespaces: {} }, current));
});


test('Arc testnet message connections accept standard EVM events without RPC', () => {
  const current = { ...account('evm'), network: '', chainId: '' };
  const proposal = { requiredNamespaces: { eip155: { chains: ['eip155:5042002'],
    methods: ['personal_sign', 'eth_sendTransaction', 'eth_signTypedData_v4'], events: ['accountsChanged', 'chainChanged'] } }, optionalNamespaces: {} };
  const granted = sessionNamespaces(proposal, current, () => false);
  assert.equal(isConformingNamespaces(proposal.requiredNamespaces, granted, 'Arc testnet'), null);
  assert.deepEqual(granted.eip155!.events, ['accountsChanged', 'chainChanged']);
  assert.deepEqual(granted.eip155!.methods, proposal.requiredNamespaces.eip155.methods);
  assert.equal(accountForWalletRequest(current, granted, 'eip155:5042002', 'eth_signTypedData_v4').network, '5042002');
});


test('Safe-style chain lists can contain more than 32 EVM networks with bounded permissions', () => {
  const current = { ...account('evm'), network: '', chainId: '' };
  const chains = Array.from({ length: 80 }, (_, index) => `eip155:${index + 1}`);
  chains.push('eip155:5042002');
  const request = { chains, methods: ['personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'eth_sign'], events: ['chainChanged', 'accountsChanged', 'message'] };
  const granted = sessionNamespaces({ requiredNamespaces: {}, optionalNamespaces: { eip155: request } }, current, () => false);
  assert.deepEqual(granted.eip155!.chains, chains);
  assert.deepEqual(granted.eip155!.events, ['chainChanged', 'accountsChanged']);
  assert.ok(!granted.eip155!.methods.includes('eth_sign'));
  assert.throws(() => sessionNamespaces({ requiredNamespaces: {}, optionalNamespaces: { eip155: { ...request, chains: Array.from({ length: 257 }, (_, index) => `eip155:${index + 1}`) } } }, current));
});
