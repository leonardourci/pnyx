import { useEffect, useRef, useState } from 'react'
import type { Command } from './connection.ts'
import type { Hit } from '../../../src/search/index.ts'
import { Button, Input, Select } from '../components/ui/controls.tsx'

interface EventRow { seq: number; id: string; at: string; card: string; summary: string; type: string }

export function History({ command, workspace, open, notify }: { command: Command; workspace: string; open(id: string): void; notify(text: string): void }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState(''), [hits, setHits] = useState<Hit[]>([]), [events, setEvents] = useState<EventRow[]>([]), [loading, setLoading] = useState(false), [before, setBefore] = useState<number | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    const gen = ++generation.current
    const timer = setTimeout(() => {
      setLoading(true)
      const args = [...(workspace ? ['--workspace', workspace] : []), ...(kind ? ['--kind', kind] : []), ...(before ? ['--before', String(before)] : []), '--limit', '50']
      void command(query.trim() ? 'search' : 'history', query.trim() ? [query, workspace] : args).then(r => {
        if (gen !== generation.current) {
          return
        }

        setHits(Array.isArray(r.hits) ? r.hits : []); setEvents(Array.isArray(r.events) ? r.events : [])
      })
        .catch(e => {
          if (gen === generation.current) {
            notify(e.message)
          }
        })
        .finally(() => {
          if (gen === generation.current) {
            setLoading(false)
          }
        })
    }, 180)

    return () => {
      clearTimeout(timer); ++generation.current
    }
  }, [command, query, workspace, kind, before, notify])

  return (
    <section className="history-page">
      <div>
        <span className="eyebrow">THE RECORDED WORK</span>
        <h1>History</h1>
        <p className="muted">Search card facts and recorded conversations.</p>
      </div>
      <div className="row wrap">
        <Input
          type="search"
          aria-label="Search history"
          placeholder="Search messages, links and decisions…"
          value={query}
          onChange={e => {
            setQuery(e.target.value); setBefore(null)
          }}
        />
        <Select
          label="Event type"
          disabled={Boolean(query.trim())}
          value={kind}
          options={[{ value: '', label: 'All events' }, ...['pushed', 'moved', 'linked', 'outcome', 'replied', 'noted'].map(k => ({ value: k, label: k }))]}
          onChange={k => {
            setKind(k); setBefore(null)
          }}
        />
        <Button
          variant="surface"
          onClick={() => {
            const blob = new Blob([JSON.stringify(query.trim() ? hits : events, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'pnyx-history.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
          }}
        >
          Export displayed results
        </Button>
      </div>
      <div className="history-results" aria-busy={loading}>
        {query.trim() ? hits.map(hit => (
          <article className="history-entry" key={hit.card}>
            <Button className="result-title" onClick={() => open(hit.card)}>{hit.title}</Button>
            {hit.snippets.map((s,i) => <p key={i} className="muted">{s.snippet}</p>)}
          </article>
        )) : events.map(e => (
          <article className="history-entry" key={e.id}>
            <span className="eyebrow">
              {new Date(e.at).toLocaleString()}
              {' '}
              · event
              {' '}
              {e.seq}
            </span>
            <Button onClick={() => open(e.card)} disabled={e.card === '$board'}>{e.summary}</Button>
            <span className="small muted">{e.type}</span>
          </article>
        ))}
        {!loading && !(query.trim() ? hits.length : events.length) && <p className="empty">No matching history.</p>}
      </div>
      {!query.trim() && (
        <div className="row">
          <Button disabled={!before} onClick={() => setBefore(null)}>Latest</Button>
          <Button disabled={events.length < 50} onClick={() => setBefore(events.at(-1)!.seq)}>Older events</Button>
        </div>
      )}
    </section>
  )
}
