import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Workspace packages are TypeScript sources: bundle them, externalize the rest.
const internal = ['@blurb/shared', '@blurb/engine', '@blurb/llm', '@blurb/host', '@blurb/render'];

export default defineConfig({
  main: {
    // get-windows is a native optional dependency: never bundle it.
    build: { externalizeDeps: { exclude: internal, include: ['get-windows'] } },
  },
  preload: {
    // Sandboxed preloads must be CommonJS.
    build: {
      externalizeDeps: { exclude: internal },
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
        },
      },
    },
  },
});
