import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 部署在子路径（如 https://example.com/games/）时设置 VITE_BASE_PATH=/games/
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE_PATH?.trim() || '/';
  // 开发/预览服务器把 /api 与 /ws 转发到本地后端；后端端口改动时设置 DEV_BACKEND。
  const backend = env.DEV_BACKEND?.trim() || 'http://127.0.0.1:8765';
  const proxy = {
    '/api': {
      target: backend,
      changeOrigin: true,
    },
    '/ws': {
      target: backend,
      changeOrigin: true,
      ws: true,
    },
  };

  return {
    base,
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      proxy,
    },
    preview: {
      host: true,
      port: 4173,
      proxy,
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
