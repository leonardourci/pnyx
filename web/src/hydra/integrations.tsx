import { useCallback, useEffect, useState } from 'react'
import { Button } from '../shared/ui/controls.tsx'
import type { Command } from './connection.ts'
import { safeLink } from './view.ts'

type Integration = {
  name: string
  status: string
  setup: string
  docs: string
}

export function IntegrationSettings({
  command,
  notify,
}: {
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [
    rows,
    setRows,
  ] = useState<Integration[] | null>(null)
  const load = useCallback(
    () => {
      setRows(null)
      void command({
        name: 'integrations',
        args: [],
      }).then(
        r => setRows(r.integrations as Integration[]),
        (e: Error) => notify({ text: e.message }),
      )
    },
    [
      command,
      notify,
    ],
  )
  useEffect(
    load,
    [load],
  )

  return (
    <section className="settings-box integrations">
      <h2>Integrations</h2>
      <p className="muted">Run a setup command in a terminal, then check again.</p>
      {rows === null ? <p className="muted">Checking…</p> : (
        <dl>
          {rows.map(row => (
            <div key={row.name}>
              <dt>{row.name}</dt>
              <dd>
                <span className={row.status === 'ready' || row.status === 'running' || row.status.startsWith('set') ? 'ok' : 'muted'}>{row.status}</span>
                <code className="mono">{row.setup}</code>
                {safeLink({
                  link: {
                    kind: 'url',
                    url: row.docs,
                  },
                }) ? <a href={row.docs} target="_blank" rel="noreferrer">{row.docs}</a> : <span className="muted">{row.docs}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <Button onClick={load}>Check again</Button>
    </section>
  )
}
