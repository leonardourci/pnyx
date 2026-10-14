import { useEffect, useState } from 'react'
import type { HybridHit } from '../../../src/search/semantic.ts'
import type { Command } from './connection.ts'

// Every search box ranks cards through the board server's search, the same
// full-text plus meaning ranking as `pnyx-axi search` and History. Weak results
// (the reranker found them unrelated, or a card found by meaning alone is not
// a strong match) are left out.
export const findCards = (command: Command, query: string, workspace = '') =>
  command('search', [query, workspace]).then(r => (r.hits as HybridHit[]).filter(h => !h.weak))

// The cards the search found strongly, by words anywhere on them (transcripts included)
// or by meaning, best first, for the board's "Find a card" box to add after its own
// matches; none with no query or before the server answers.
export function useFoundCards(command: Command, query: string, workspace: string): HybridHit[] {
  const [found, setFound] = useState<{ query: string; hits: HybridHit[] } | null>(null)
  const q = query.trim()
  useEffect(() => {
    if (!q) {
      return
    }

    let live = true
    const timer = setTimeout(() => {
      void findCards(command, q, workspace).then(hits => {
        if (live) {
          setFound({ query: `${q}\n${workspace}`, hits })
        }
      }, () => {})
    }, 180)

    return () => {
      live = false; clearTimeout(timer)
    }
  }, [command, q, workspace])

  return q && found?.query === `${q}\n${workspace}` ? found.hits : []
}
