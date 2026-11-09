import assert from 'node:assert/strict';
import test from 'node:test';
import { networkPolicyHtml, rpcEndpoints } from '../src/network/config';
import { createRpcClient } from '../src/network/rpc';

const endpoint = rpcEndpoints()[0]!;
const signal = () => new AbortController().signal;
function responseFetcher(body: (id: number) => unknown, inspect?: (options: RequestInit) => void): typeof fetch {
  return async (_url, options) => {
    inspect?.(options!);
    const request = JSON.parse(options!.body as string);
    return new Response(JSON.stringify(body(request.id)));
  };
}

test('RPC endpoint configuration validates explicit networks, transport, duplicate URLs and bounded names', () => {
  assert.equal(rpcEndpoints().length, 3); assert.deepEqual(rpcEndpoints('[]'), []);
  const custom = rpcEndpoints(JSON.stringify([{ name: 'Local RPC', network: 'devnet', url: 'http://127.0.0.1:8899' }]));
  assert.equal(custom[0]!.url, 'http://127.0.0.1:8899/'); assert.ok(Object.isFrozen(custom[0]));
  for (const input of [null, {}, Array(17).fill(endpoint), [endpoint, endpoint],
    [{ ...endpoint, url: 'http://rpc.example/' }], [{ ...endpoint, url: 'https://user:password@rpc.example/' }],
    [{ ...endpoint, url: 'https://rpc.example/#fragment' }], [{ ...endpoint, url: 'javascript:alert(1)' }],
    [{ ...endpoint, network: 'toString' }], [{ ...endpoint, network: 'unknown' }], [{ ...endpoint, name: '' }],
    [{ ...endpoint, name: 'x'.repeat(81) }], [{ ...endpoint, extra: true }]]) assert.throws(() => rpcEndpoints(JSON.stringify(input)));
  assert.throws(() => rpcEndpoints('[{"name":"x","name":"y"}]'));
});

test('Build policy grants only configured RPC origins and keeps the offline network policy closed', () => {
  const html = '<meta content="default-src \'none\'; connect-src wss://relay.walletconnect.org; object-src \'none\'">';
  const configured = rpcEndpoints(JSON.stringify([{ name: 'RPC', network: 'devnet', url: 'https://rpc.example/private/key?apikey=secret' }]));
  const online = networkPolicyHtml(html, false, configured);
  assert.ok(online.includes('connect-src wss://relay.walletconnect.org https://rpc.example;'));
  assert.ok(!online.includes('secret')); assert.ok(!online.includes('private'));
  assert.ok(networkPolicyHtml(html, true, configured).includes("connect-src 'none';"));
});

test('RPC requests bind response IDs and use one credential-free POST without redirects or retries', async () => {
  let calls = 0;
  const rpc = createRpcClient(endpoint, responseFetcher((id) => ({ jsonrpc: '2.0', id, result: 'genesis' }), (options) => {
    calls++;
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store'); assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(JSON.parse(options.body as string).method, 'getGenesisHash');
  }));
  assert.equal(await rpc.call('getGenesisHash', [], signal()), 'genesis'); assert.equal(calls, 1);
  await assert.rejects(rpc.call('sendTransaction' as 'getGenesisHash', [], signal())); assert.equal(calls, 1);
});

test('RPC rejects mismatched IDs, duplicates, malformed envelopes and unsafe errors', async () => {
  for (const body of [
    (id: number) => ({ jsonrpc: '2.0', id: id + 1, result: true }),
    (id: number) => ({ jsonrpc: '1.0', id, result: true }),
    (id: number) => ({ jsonrpc: '2.0', id, result: true, error: { code: 1 } }),
    (id: number) => ({ jsonrpc: '2.0', id }),
    (id: number) => ({ jsonrpc: '2.0', id, error: { code: 1.5, message: 'secret reflected data' } }),
  ]) await assert.rejects(createRpcClient(endpoint, responseFetcher(body)).call('getGenesisHash', [], signal()));
  const duplicate: typeof fetch = async (_url, options) => {
    const { id } = JSON.parse(options!.body as string);
    return new Response(`{"jsonrpc":"2.0","id":${id},"result":1,"result":2}`);
  };
  await assert.rejects(createRpcClient(endpoint, duplicate).call('getGenesisHash', [], signal()), /Duplicate/);
  const error = responseFetcher((id) => ({ jsonrpc: '2.0', id, error: { code: -32602, message: 'private-key-reflected-by-server' } }));
  await assert.rejects(createRpcClient(endpoint, error).call('getGenesisHash', [], signal()), (value: unknown) =>
    value instanceof Error && value.message.includes('-32602') && !value.message.includes('private-key'));
});

test('RPC enforces streamed response limits, valid UTF-8, HTTP errors and JSON syntax', async () => {
  const invalid: typeof fetch[] = [
    async () => new Response('rate limited', { status: 429 }),
    async () => new Response('not JSON'),
    async () => new Response(new Uint8Array([0xff])),
    async () => new Response('small', { headers: { 'Content-Length': '1048577' } }),
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1048577)); controller.close(); } })),
  ];
  for (const fetcher of invalid) await assert.rejects(createRpcClient(endpoint, fetcher).call('getGenesisHash', [], signal()));
});

test('RPC cancellation discards a late response and a pre-cancelled request sends nothing', async () => {
  let calls = 0, complete!: () => void;
  const gate = new Promise<void>((resolve) => { complete = resolve; });
  const fetcher: typeof fetch = async (_url, options) => {
    calls++; const { id } = JSON.parse(options!.body as string); await gate;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: true }));
  };
  const rpc = createRpcClient(endpoint, fetcher), abort = new AbortController();
  const pending = rpc.call('getGenesisHash', [], abort.signal);
  abort.abort(); complete(); await assert.rejects(pending, /取消/);
  await assert.rejects(rpc.call('getGenesisHash', [], abort.signal)); assert.equal(calls, 1);
});

test('RPC request timeout aborts the active request and never retries', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const pending = createRpcClient(endpoint, fetcher).call('getGenesisHash', [], signal());
  context.mock.timers.tick(15001);
  await assert.rejects(pending, /超时/); assert.equal(calls, 1);
});
