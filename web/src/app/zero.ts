import { Zero } from '@rocicorp/zero'
import { schema } from '#store/zero-schema.ts'
import { ZERO_OWNER, ZERO_PATH } from '#app/server-protocol.ts'
import { log } from './log.ts'

// Zero drops a quiet socket after two ping waits and starts its sync over; one 1 MiB first-sync chunk on a slow link
// outlasts two of the default 5 s waits.
const PING_TIMEOUT_MS = 10_000

// The page's one Zero client while the connection runs; the connection's views and every useQuery read through it.
let current: Zero | undefined

// zero-cache is on the page's own origin behind the token cookie; each installation keeps its own cached rows.
export function openPageZero({ installation }: { installation: string }) {
  if (!current) {
    current = new Zero({
      schema,
      cacheURL: `${location.origin}${ZERO_PATH}`,
      userID: ZERO_OWNER,
      storageKey: installation,
      pingTimeoutMs: PING_TIMEOUT_MS,
    })
  }

  return current
}

// A connection that starts again opens a new client, since a closed one never reads again.
export function closePageZero() {
  const closing = current
  current = undefined
  closing?.close().catch((error: unknown) => log({
    level: 'warn',
    operation: 'page.zero',
    error,
  }))
}
