// A short-lived connection to the local Paseo daemon through its public SDK.
// The daemon owns the agents; Pnyx never starts, restarts or supervises it.
import { createPaseoClient, type PaseoClient } from '@getpaseo/client'
import { BoardError } from '../../core/model.ts'

export type Connect = (options: { url: string }) => Promise<PaseoClient>

export async function openPaseo({ url }: { url: string }): Promise<PaseoClient> {
  const client = createPaseoClient({
    url,
    connectTimeoutMs: 5000,
    reconnect: { enabled: false },
  })

  try {
    await client.connect()

    return client
  } catch {
    await client.close().catch(() => undefined)
    throw new BoardError(`Paseo is not running at ${url}`, 'PASEO_UNAVAILABLE', [
      'Start it with `paseo start` or open the Paseo app, then try again',
      'Set PNYX_PASEO_URL when the daemon listens elsewhere',
    ])
  }
}
