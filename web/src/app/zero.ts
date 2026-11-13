import { useSyncExternalStore } from 'react'
import { Zero } from '@rocicorp/zero'
import { schema } from '#store/zero-schema.ts'
import { ZERO_OWNER, ZERO_PATH } from '#app/server-protocol.ts'
import { log } from './log.ts'

// The page's one Zero client while the connection runs; the connection's views and every useQuery read through it.
let current: Zero | undefined
const listeners = new Set<() => void>()

const changed = () => listeners.forEach(listener => listener())

// eslint-disable-next-line pnyx/object-params -- React useSyncExternalStore subscription contract.
const subscribe = (listener: () => void) => {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

// The client a component's ZeroProvider takes, or none before the connection opens one.
export const usePageZero = () => useSyncExternalStore(
  subscribe,
  () => current,
)

// zero-cache is on the page's own origin behind the token cookie; each installation keeps its own cached rows.
export function openPageZero({ installation }: { installation: string }) {
  if (!current) {
    current = new Zero({
      schema,
      cacheURL: `${location.origin}${ZERO_PATH}`,
      userID: ZERO_OWNER,
      storageKey: installation,
    })
    changed()
  }

  return current
}

// A connection that starts again opens a new client, since a closed one never reads again.
export function closePageZero() {
  const closing = current
  current = undefined
  changed()
  closing?.close().catch((error: unknown) => log({
    level: 'warn',
    operation: 'page.zero',
    error,
  }))
}
