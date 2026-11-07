import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // One fixed origin, http://127.0.0.1:5173, which scripts/dev.sh has the
    // backend's WebSocket admit (with localhost's spelling of it).
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // @my-service/client is a sibling package linked from ../client; let the
    // dev server read it.
    fs: { allow: ['..'] },
  },
});
