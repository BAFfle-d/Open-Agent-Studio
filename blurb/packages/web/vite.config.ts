import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy the relay so the page can use same-origin /ws.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true }, '/api': 'http://localhost:8787' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
