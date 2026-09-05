import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), wasm()],
    build: {
      target: 'esnext',
    },
    worker: {
      format: 'es' as const,
      plugins: () => [wasm()],
    },
    optimizeDeps: {
      exclude: ['tfhe', 'node-tfhe'],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
