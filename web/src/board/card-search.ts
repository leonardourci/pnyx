import { useEffect, useState } from 'react'
import type { HybridHit } from '../../../src/search/semantic.ts'
import type { Command } from './connection.ts'

// Every search box ranks cards through the board server's search, the same
// full-text plus meaning ranking as `pnyx-axi search` and History. Weak results
// (the reranker found them unrelated, or a card found by meaning alone is not
// a strong match) are left out.
export const findCards = ({ command, query, workspace = '', live = false }: { command: Command; query: string; workspace?: string; live?: boolean }) =>
  command({ name: 'search', args: [query, workspace, ...(live ? ['board'] : [])] }).then(r => (r.hits as HybridHit[]).filter(h => !h.weak))

export function useFoundCards({ command, query, workspace, revision }: {
  command: Command
  query: string
  workspace: string
  revision: number
}): HybridHit[] {
  const [found, setFound] = useState<{ query: string; hits: HybridHit[] } | null>(null)
  const q = query.trim()
  useEffect(() => {
    if (!q) {
      return
    }

    let live = true
    const timer = setTimeout(() => {
      void findCards({ command, query: q, workspace, live: true }).then(hits => {
        if (live) {
          setFound({ query: `${q}\n${workspace}`, hits })
        }
      }, () => {})
    }, 180)

    return () => {
      live = false; clearTimeout(timer)
    }
  }, [command, q, workspace, revision])

  return q && found?.query === `${q}\n${workspace}` ? found.hits : []
}
