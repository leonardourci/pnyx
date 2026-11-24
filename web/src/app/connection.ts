import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createTitanConnection } from './connection-store.ts'

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

export function useTitan() {
  const [connection] = useState(createTitanConnection)
  const snapshot = useSyncExternalStore(
    connection.subscribe,
    connection.snapshot,
  )
  useEffect(
    () => connection.start(),
    [connection],
  )

  return useMemo(
    () => ({
      ...snapshot,
      workspaces: connection.workspaces(),
      command: connection.commandFor({ id: snapshot.navigation.hydraId }),
      // Another Titan's command, over the same connection; the Oracle sends requests to any Titan.
      commandFor: connection.commandFor,
      navigate: connection.navigate,
      createTitan: connection.create,
      retryTitan: connection.retry,
      dismissError: connection.dismissError,
    }),
    [
      connection,
      snapshot,
    ],
  )
}
