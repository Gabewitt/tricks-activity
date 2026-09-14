import { defineConfig } from 'vite';

// Dev: Discord loads the app through a cloudflared tunnel -> Vite.
// Requests the client makes to /.proxy/api and /.proxy/ws are rewritten
// by Discord to /api and /ws, which Vite forwards to the Express server.
export default defineConfig({
  root: 'client',
  envDir: '..',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    allowedHosts: true,
    hmr: { clientPort: 443 },
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
