import { useEffect, useState, useSyncExternalStore } from 'react'
import { createHydraConnection } from './connection-store.ts'

export { reconnectDelay, retryable, commandTimeout, withChanges } from './connection-protocol.ts'

export type Receipt = Record<string, unknown>
export type Command = (({
  name,
  args,
  onChecking,
}: {
  name: string
  args: string[]
  onChecking?(): void
}) => Promise<Receipt>) & { retain?(): () => void }

export function useHydra() {
  const [connection] = useState(createHydraConnection)
  const snapshot = useSyncExternalStore(
    connection.subscribe,
    connection.snapshot,
  )
  useEffect(
    () => connection.start(),
    [connection],
  )

  return {
    ...snapshot,
    command: connection.commandFor({ id: snapshot.navigation.hydraId }),
    // Another Hydra's command, over the same connection; the Oracle sends requests to any Hydra.
    commandFor: connection.commandFor,
    navigate: connection.navigate,
    createHydra: connection.create,
    retryHydra: connection.retry,
  }
}
