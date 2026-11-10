import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { rpcEndpoints, evmRpcEndpoints, networkPolicyHtml } from './src/network/config.ts';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig(({ mode }) => {
  const offline = mode === 'offline';
  const environment = loadEnv(mode, process.cwd(), 'CANOKEY_');
  const endpoints = offline ? [] : rpcEndpoints(environment.CANOKEY_SOLANA_RPC_ENDPOINTS || undefined);
  const evmEndpoints = offline ? [] : evmRpcEndpoints();
  return {
    base: './',
    define: { __WALLETCONNECT__: !offline, __SOLANA_RPC_ENDPOINTS__: JSON.stringify(endpoints), __EVM_RPC_ENDPOINTS__: JSON.stringify(evmEndpoints) },
    plugins: [{ name: 'network-policy', transformIndexHtml(html) {
      return networkPolicyHtml(html.replace('__CANOKEY_VERSION__', version), offline, [...endpoints, ...evmEndpoints]);
    } }],
    server: {
      host: '127.0.0.1',
      hmr: false,
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    },
    preview: {
      host: '127.0.0.1',
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    },
    build: { target: 'es2022', outDir: mode === 'offline' ? 'dist-offline' : 'dist' },
  };
});
