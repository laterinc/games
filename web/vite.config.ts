import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// 开发/预览服务器把 /api 与 /ws 转发到本地后端（默认 8765）。
// 生产环境由 Nginx（或 CDN）托管 dist 并反代 /api、/ws，不使用这里的配置。
const BACKEND = 'http://127.0.0.1:8765';

const proxy = {
  '/api': {
    target: BACKEND,
    changeOrigin: true,
  },
  '/ws': {
    target: BACKEND,
    changeOrigin: true,
    ws: true,
  },
};

export default defineConfig(({ mode }) => {
  // 部署在子路径（如 https://example.com/gomoku/）时设置 VITE_BASE_PATH=/gomoku/
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE_PATH?.trim() || '/';

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
