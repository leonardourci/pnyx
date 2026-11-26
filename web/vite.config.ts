import type { IncomingMessage } from 'node:http'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig, type Plugin } from 'vite'
import { hydraIdentity, localToken } from '#app/server-state.ts'

const PORT = Number(process.env.OTHRYS_DEV_PORT ?? 4319)
const SERVER = `http://127.0.0.1:${PORT}`

// The Titan server accepts only its own origin, so a request from a page this dev server served is passed on as one from
// the server's own page; any other origin passes through and is refused.
const fromDevPage = ({ req }: { req: IncomingMessage }) => req.headers.origin === `http://${req.headers.host}`

// The dev page gets the same token meta the Titan server injects into the built page.
const devToken: Plugin = {
  name: 'othrys-dev-token',
  apply: 'serve',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        name: 'othrys-token',
        content: localToken(),
      },
      injectTo: 'head',
    },
    {
      tag: 'meta',
      attrs: {
        name: 'othrys-hydra',
        content: hydraIdentity({ titanId: 'dev' }),
      },
      injectTo: 'head',
    },
    {
      tag: 'meta',
      attrs: {
        name: 'othrys-installation',
        content: hydraIdentity({ titanId: '' }),
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
    alias: process.env.VITE_OTHRYS_PROFILE === '1' ? { 'react-dom/client': 'react-dom/profiling' } : {},
    conditions: [
      ...defaultClientConditions,
      'source',
    ],
  },
  build: {
    sourcemap: process.env.VITE_OTHRYS_PROFILE === '1',
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/folders': {
        target: SERVER,
        changeOrigin: true,
        // eslint-disable-next-line othrys/object-params
        rewrite: path => `/hydra/dev${path}`,
      },
      '/ws': {
        target: SERVER,
        ws: true,
        changeOrigin: true,
        configure: proxy => proxy.on(
          'proxyReqWs',
          (
            proxyReq,
            req,
          ) => {
            if (fromDevPage({ req })) {
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
