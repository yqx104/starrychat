import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], clearMocks: true },
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      proxy: {
        '/adaptor-api': {
          target: env.ADAPTOR_API_TARGET || 'http://127.0.0.1:4183',
          changeOrigin: false,
          rewrite: (path: string) => path.replace(/^\/adaptor-api/, ''),
        },
      },
    },
  };
});
