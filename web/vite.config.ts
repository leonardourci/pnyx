import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig, type Plugin } from 'vite'
import { ZERO_PATH, zeroCookieName } from '#app/server-protocol.ts'
import { hydraIdentity, localToken } from '#app/server-state.ts'

// `pnpm dev` runs `pnyx-axi serve --hydra dev` on this port; the dev server forwards the Hydra's WebSocket to it.
const PORT = Number(process.env.PNYX_DEV_PORT ?? 4319)
const SERVER = `http://127.0.0.1:${PORT}`

// The dev page never gets the token cookie the Hydra server's page sets, so its Zero requests carry it here.
const zeroCookie = () => `${zeroCookieName({ port: PORT })}=${localToken()}`

// The dev page gets the same token meta the Hydra server injects into the built page.
const devToken: Plugin = {
  name: 'pnyx-dev-token',
  apply: 'serve',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        name: 'pnyx-token',
        content: localToken(),
      },
      injectTo: 'head',
    },
    {
      tag: 'meta',
      attrs: {
        name: 'pnyx-hydra',
        content: hydraIdentity({ hydraId: 'dev' }),
      },
      injectTo: 'head',
    },
    {
      tag: 'meta',
      attrs: {
        name: 'pnyx-installation',
        content: hydraIdentity({ hydraId: '' }),
      },
      injectTo: 'head',
    },
  ],
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    tailwindcss(),
    devToken,
  ],
  resolve: {
    conditions: [
      ...defaultClientConditions,
      'source',
    ],
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      [ZERO_PATH]: {
        target: SERVER,
        ws: true,
        changeOrigin: true,
        configure: proxy => {
          proxy.on(
            'proxyReq',
            proxyReq => proxyReq.setHeader(
              'cookie',
              zeroCookie(),
            ),
          )
          proxy.on(
            'proxyReqWs',
            proxyReq => proxyReq.setHeader(
              'cookie',
              zeroCookie(),
            ),
          )
        },
      },
      '/folders': {
        target: SERVER,
        changeOrigin: true,
        // eslint-disable-next-line pnyx/object-params
        rewrite: path => `/hydra/dev${path}`,
      },
      '/ws': {
        target: SERVER,
        ws: true,
        changeOrigin: true,
        // The Hydra server accepts only its own origin. A page served by this dev
        // server is rewritten to it; any other origin passes through and is refused.
        configure: proxy => proxy.on(
          'proxyReqWs',
          (
            proxyReq,
            req,
          ) => {
            if (req.headers.origin === `http://${req.headers.host}`) {
              proxyReq.setHeader(
                'origin',
                SERVER,
              )
            }
          },
        ),
      },
    },
  },
})
