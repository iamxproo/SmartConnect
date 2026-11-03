/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Loopback only, like the rest of the local stack.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Same-origin API in development: the gateway (make gateway-start) listens on :3000, the realtime gateway
    // (make realtime-start) on :3105. Override with VITE_API_BASE_URL / VITE_REALTIME_URL to use another origin, or
    // point the proxy elsewhere with WEB_DEV_API_TARGET / WEB_DEV_REALTIME_TARGET (the browser tests' own stack).
    proxy: {
      '/api': process.env.WEB_DEV_API_TARGET ?? 'http://127.0.0.1:3000',
      '/realtime': { target: process.env.WEB_DEV_REALTIME_TARGET ?? 'http://127.0.0.1:3105', ws: true },
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      output: {
        // Rarely-changing framework code in separate chunks: app deploys don't invalidate their cache.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'router', test: /node_modules[\\/]@tanstack[\\/]/, priority: 20 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
