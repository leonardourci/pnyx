import { useEffect, useState } from 'react'
import type { Hit } from '../../../src/oracle/index.ts'
import type { Command } from './connection.ts'

// Every search box ranks cards through the Hydra server's search, the same
// full-text ranking as `pnyx-axi oracle` and recorded history.
export const findCards = ({
  command,
  query,
  workspace = '',
  live = false,
}: {
  command: Command
  query: string
  workspace?: string
  live?: boolean
}) =>
  command({
    name: 'oracle',
    args: [
      query,
      workspace,
      ...(live ? ['hydra'] : []),
    ],
  }).then(r => r.hits as Hit[])

export function useFoundCards({
  command,
  query,
  workspace,
  revision,
}: {
  command: Command
  query: string
  workspace: string
  revision: number
}): Hit[] {
  const [
    found,
    setFound,
  ] = useState<{
    query: string
    hits: Hit[]
  } | null>(null)
  const q = query.trim()
  useEffect(
    () => {
      if (!q) {
        return
      }

      let live = true
      const timer = setTimeout(
        () => {
          void findCards({
            command,
            query: q,
            workspace,
            live: true,
          }).then(
            hits => {
              if (live) {
                setFound({
                  query: `${q}\n${workspace}`,
                  hits,
                })
              }
            },
            () => {},
          )
        },
        180,
      )

      return () => {
        live = false; clearTimeout(timer)
      }
    },
    [
      command,
      q,
      workspace,
      revision,
    ],
  )

  return q && found?.query === `${q}\n${workspace}` ? found.hits : []
}
