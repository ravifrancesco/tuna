import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the interface runs on Vite and talks to the Tuna server on :7778.
// In production the Tuna server serves this build itself.
const server = process.env.TUNA_DEV_SERVER ?? 'http://127.0.0.1:7778';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    proxy: { '/api': server },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // TV browsers lag behind (Samsung TVs from 2022 run Chromium 85).
    target: ['chrome85', 'safari15', 'firefox100', 'edge88'],
    cssTarget: ['chrome85', 'safari15', 'firefox100', 'edge88'],
    chunkSizeWarningLimit: 900,
  },
});
