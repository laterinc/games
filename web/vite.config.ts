import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发服务器把 REST 与 WebSocket 都转发到本地后端（默认 8765）。
const BACKEND = 'http://127.0.0.1:8765';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/ws': {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
