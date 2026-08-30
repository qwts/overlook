import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// Vite's dev tooling needs CSP allowances production must never ship: the
// React Fast Refresh preamble is an inline script, @vite/client spawns a
// blob: worker, and HMR runs over a websocket. While serving, swap the strict
// production policy in index.html (kept there as the source of truth) for
// this dev policy.
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: overlook-full:",
  "worker-src 'self' blob:",
  // Mirror production's protocol allowances (#75 thumbs, #91 full-res).
  "img-src 'self' overlook-thumb: overlook-full:",
  // Range-served video originals + the MPEG-TS MediaSource remux path (#548,
  // ADR-0026 §5): overlook-full: streams the original, blob: is the MSE object URL.
  "media-src 'self' overlook-full: blob:",
].join('; ');

function relaxCspForDev(): Plugin {
  return {
    name: 'overlook:relax-csp-for-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      const swapped = html.replace(/content="default-src [^"]*"/, `content="${DEV_CSP}"`);
      if (swapped === html) {
        throw new Error('relax-csp-for-dev: CSP meta tag not found in index.html');
      }
      return swapped;
    },
  };
}

// Production build hardening (#460): minify every bundle and emit no source
// maps, so the shipped app carries neither readable source nor map files that
// could re-expand it. electron-vite leaves main/preload unminified by default
// (only the renderer inherits Vite's production minify), so main and preload
// set it explicitly here — and pinning it on all three stops a silent
// regression if the electron-vite default ever changes. esbuild (not terser)
// keeps builds fast while still stripping whitespace, comments, and locals.
const HARDENED_BUILD = {
  minify: 'esbuild',
  sourcemap: false,
} as const;

export default defineConfig({
  main: {
    define: {
      __OVERLOOK_GOOGLE_DRIVE_CLIENT_ID__: JSON.stringify(process.env['OVERLOOK_GOOGLE_DRIVE_CLIENT_ID'] ?? ''),
      __OVERLOOK_GOOGLE_DRIVE_CLIENT_SECRET__: JSON.stringify(process.env['OVERLOOK_GOOGLE_DRIVE_CLIENT_SECRET'] ?? ''),
      __OVERLOOK_PCLOUD_ENABLED__: JSON.stringify(process.env['OVERLOOK_PCLOUD_ENABLED'] ?? ''),
      __OVERLOOK_PCLOUD_CLIENT_ID__: JSON.stringify(process.env['OVERLOOK_PCLOUD_CLIENT_ID'] ?? ''),
      __OVERLOOK_IMAGE_TRAIL_EXTENSION_ID__: JSON.stringify(process.env['OVERLOOK_IMAGE_TRAIL_EXTENSION_ID'] ?? ''),
    },
    build: {
      ...HARDENED_BUILD,
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          // The #86 thumbnail worker boots via new Worker(url) at runtime,
          // so it needs its own bundle entry next to index.js.
          'thumbnail-worker': 'src/main/import/thumbnail-worker.ts',
          // ADR-0018 uses the same dedicated-entry shape for the embedding
          // worker so native inference never runs on the main thread.
          'embedding-worker': 'src/main/embedding/embedding-worker.ts',
          // Windows keeps blocking named-pipe syscalls off Electron's main
          // thread while the native addon owns the explicit DACL.
          'windows-pipe-worker': 'src/main/interop/windows-pipe-worker.ts',
          // The native-host client authenticates the exact connected server
          // handle without blocking Electron's main thread.
          'windows-pipe-client-worker': 'src/main/interop/windows-pipe-client-worker.ts',
        },
      },
    },
  },
  preload: {
    build: {
      ...HARDENED_BUILD,
      rollupOptions: {
        output: {
          // Sandboxed renderers can only load CJS preloads; the package is ESM
          // ("type": "module"), so the preload bundle must opt out explicitly.
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    build: {
      ...HARDENED_BUILD,
      rollupOptions: {
        input: {
          // The app shell and the hidden poster-capture page (#548, §6) are
          // separate HTML entries; the capturer loads capture.html offscreen.
          index: resolve('src/renderer/index.html'),
          capture: resolve('src/renderer/capture.html'),
        },
      },
    },
    plugins: [react(), relaxCspForDev()],
  },
});
