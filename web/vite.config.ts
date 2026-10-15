import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { hydraIdentity, localToken } from '../src/server/state.ts'

// `pnpm dev` runs `pnyx-axi serve --hydra dev` on this port; the dev server forwards the Hydra's WebSocket to it.
const SERVER = `http://127.0.0.1:${process.env.PNYX_DEV_PORT ?? 4319}`

// The dev page gets the same token meta the Hydra server injects into the built page.
const devToken: Plugin = {
  name: 'pnyx-dev-token',
  apply: 'serve',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { name: 'pnyx-token', content: localToken() }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'pnyx-hydra', content: hydraIdentity({ hydraId: 'dev' }) }, injectTo: 'head' },
  ],
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss(), devToken],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/ws': {
        target: SERVER,
        ws: true,
        changeOrigin: true,
        // The Hydra server accepts only its own origin. A page served by this dev
        // server is rewritten to it; any other origin passes through and is refused.
        configure: proxy => proxy.on('proxyReqWs', (proxyReq, req) => {
          if (req.headers.origin === `http://${req.headers.host}`) {
            proxyReq.setHeader('origin', SERVER)
          }
        }),
      },
    },
  },
})
