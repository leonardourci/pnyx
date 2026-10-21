import { useEffect, useState } from 'react'
import type { Command } from './connection.ts'

type Entries = Record<string, string>

export function useOraclePreferences({
  command,
  notify,
  enabled = true,
}: {
  command: Command
  notify({ text }: { text: string }): void
  enabled?: boolean
}) {
  const [
    confirmed,
    setConfirmed,
  ] = useState<Entries | null>(null)
  const [
    pending,
    setPending,
  ] = useState<Record<string, {
    key: string
    value: string
  }>>({})
  const [
    error,
    setError,
  ] = useState('')
  useEffect(
    () => {
      if (!enabled) {
        return
      }

      let active = true
      void command({
        name: 'settings',
        args: [],
      }).then(
        r => {
          if (active) {
            setConfirmed(r.settings as Entries); setError('')
          }
        },
        (e: Error) => {
          if (active) {
            setError(e.message); notify({ text: e.message })
          }
        },
      )

      return () => {
        active = false
      }
    },
    [
      command,
      notify,
      enabled,
    ],
  )

  const set = ({
    key,
    value,
  }: {
    key: string
    value: string
  }) => {
    const id = crypto.randomUUID()
    setPending(pending => ({
      ...pending,
      [id]: {
        key,
        value,
      },
    }))

    return command({
      name: 'settings',
      args: [
        'set',
        key,
        value,
      ],
    }).then(r => {
      setConfirmed(r.settings as Entries)
    })
      .finally(() => setPending(pending => {
        const next = { ...pending }; delete next[id]

        return next
      }))
  }

  const settings = confirmed || Object.keys(pending).length > 0 ? {
    ...confirmed,
    ...Object.fromEntries(Object.values(pending).map(({
      key,
      value,
    }) => [
      key,
      value,
    ])),
  } : null

  return {
    settings,
    set,
    error,
  }
}
