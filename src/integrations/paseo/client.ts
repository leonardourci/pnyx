import { createPaseoClient, type PaseoClient } from '@getpaseo/client'
import { HydraError } from '../../core/model.ts'

export type Connect = ({ url }: { url: string }) => Promise<PaseoClient>

export async function openPaseo({ url, reconnect = false }: {
  url: string
  reconnect?: boolean
}): Promise<PaseoClient> {
  const client = createPaseoClient({
    url,
    connectTimeoutMs: 5000,
    reconnect: { enabled: reconnect, baseDelayMs: 500, maxDelayMs: 10000 },
  })

  try {
    await client.connect()

    return client
  } catch {
    await client.close().catch(() => undefined)
    throw new HydraError({
      message: `Paseo is not running at ${url}`,
      code: 'PASEO_UNAVAILABLE',
      help: ['Start it with `paseo start` or open the Paseo app, then try again', 'Set PNYX_PASEO_URL when the daemon listens elsewhere'],
    })
  }
}
