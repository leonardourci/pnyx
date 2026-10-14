import { useEffect, useState } from 'react'
import type { HybridHit } from '../../../src/search/semantic.ts'
import type { Command } from './connection.ts'

// Every search box ranks cards through the board server's search, the same
// full-text plus meaning ranking as `pnyx-axi search` and History. Weak results
// (the reranker found them unrelated) are left out.
export const findCards = (command: Command, query: string, workspace = '') =>
  command('search', [query, workspace]).then(r => (r.hits as HybridHit[]).filter(h => !h.weak))

// The cards the board's "Find a card" box matches, best first, or null with no
// query or before the server answers (the box then filters titles locally).
export function useCardSearch(command: Command, query: string, workspace: string): string[] | null {
  const [found, setFound] = useState<{ query: string; ids: string[] } | null>(null)
  const q = query.trim()
  useEffect(() => {
    if (!q) {
      return
    }

    let live = true
    const timer = setTimeout(() => {
      void findCards(command, q, workspace).then(hits => {
        if (live) {
          setFound({ query: `${q}\n${workspace}`, ids: hits.map(h => h.card) })
        }
      }, () => {})
    }, 180)

    return () => {
      live = false; clearTimeout(timer)
    }
  }, [command, q, workspace])

  return q && found?.query === `${q}\n${workspace}` ? found.ids : null
}
