// The local Paseo daemon endpoint a task's agent is started through.
import { BoardError } from './model.ts'

// Paseo's documented default listen address.
export const DEFAULT_PASEO_URL = 'ws://127.0.0.1:6767/ws'

// Only a loopback daemon, with no credentials in the URL.
export function localPaseoUrl({ url }: { url: string }): string {
  try {
    const parsed = new URL(url)

    if (parsed.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
      && parsed.pathname === '/ws' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
      return parsed.href
    }
  } catch { /* Every unsupported endpoint gets the same error. */ }

  throw new BoardError('Paseo needs a local ws://127.0.0.1:<port>/ws endpoint', 'VALIDATION_ERROR')
}

// The daemon this machine's Pnyx starts agents through: PNYX_PASEO_URL, else Paseo's default.
export function paseoUrl({ url }: { url?: string } = {}): string {
  return localPaseoUrl({ url: url ?? process.env.PNYX_PASEO_URL ?? DEFAULT_PASEO_URL })
}
