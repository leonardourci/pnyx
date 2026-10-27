import { useEffect, useSyncExternalStore } from 'react'
import type { Command } from './connection.ts'
import { oracleSettings } from './installation-resources.ts'

export function useOraclePreferences({
  command,
  notify,
  enabled = true,
}: {
  command: Command
  notify({ text }: { text: string }): void
  enabled?: boolean
}) {
  const resource = oracleSettings()
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  )
  useEffect(
    () => {
      if (enabled) {
        void resource.refresh({
          command,
          name: 'settings',
          args: [],
        })
      }
    },
    [
      command,
      enabled,
      resource,
    ],
  )
  useEffect(
    () => {
      if (enabled && snapshot.error) {
        notify({ text: snapshot.error })
      }
    },
    [
      enabled,
      snapshot.error,
      notify,
    ],
  )

  const set = ({
    key,
    value,
  }: {
    key: string
    value: string
  }) => resource.write({
    command,
    name: 'settings',
    args: [
      'set',
      key,
      value,
    ],
    patch: { [key]: value },
    targets: [key],
  })

  return {
    settings: snapshot.view,
    set,
    error: snapshot.error,
  }
}
