import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: env.IM_API_TARGET ? [] : [{
      name: 'im-api-unconfigured',
      configureServer(server) {
        server.middlewares.use('/im-api', (_request, response) => {
          response.statusCode = 503;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ error: { code: 'DEV_BACKEND_NOT_CONFIGURED', message: '尚未配置 IM 后端地址，请设置 IM_API_TARGET 后重新启动前端。' } }));
        });
      },
    }],
    server: {
      proxy: env.IM_API_TARGET ? {
        '/im-api': {
          target: env.IM_API_TARGET,
          // Preserve the browser Host and Origin so same-origin checks remain meaningful.
          changeOrigin: false,
          rewrite: (path) => path.replace(/^\/im-api/, ''),
        },
      } : undefined,
    },
    test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], clearMocks: true },
  };
});
