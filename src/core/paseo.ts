import { BoardError } from './model.ts'

// Paseo's documented default listen address.
export const DEFAULT_PASEO_URL = 'ws://127.0.0.1:6767/ws'

export function localPaseoUrl({ url }: { url: string }): string {
  try {
    const parsed = new URL(url)

    if (parsed.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
      && parsed.pathname === '/ws' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
      return parsed.href
    }
  } catch { /* Every unsupported endpoint gets the same error. */ }

  throw new BoardError({ message: 'Paseo needs a local ws://127.0.0.1:<port>/ws endpoint', code: 'VALIDATION_ERROR' })
}

export function paseoUrl({ url }: { url?: string } = {}): string {
  return localPaseoUrl({ url: url ?? process.env.PNYX_PASEO_URL ?? DEFAULT_PASEO_URL })
}
