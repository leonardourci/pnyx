import { useEffect, useState } from 'react'
import type { Command } from './connection.ts'
import { Select, Switch } from '../components/ui/controls.tsx'

type Entries = Record<string, string>

const RERANK = [
  { value: 'auto', label: 'Auto: on with a GPU' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

// This machine's search settings, shared by every board.
export function SearchSettings({ command, notify }: {
  command: Command
  notify(text: string): void
}) {
  const [settings, setSettings] = useState<Entries | null>(null)
  useEffect(() => {
    void command('settings', []).then(r => setSettings(r.settings as Entries))
      .catch(e => notify(e.message))
  }, [command, notify])
  const set = (key: string, value: string) => command('settings', ['set', key, value]).then(r => {
    setSettings(r.settings as Entries); notify('Search settings saved')
  }, e => notify(e.message))

  return (
    <section className="settings-box" aria-label="Search">
      <h2>Search</h2>
      <p className="muted">
        Every search finds cards by meaning, in any language, as well as by words. It runs
        local models on this machine, downloaded on first use. Turn it off on a slow laptop.
      </p>
      {settings && (
        <>
          <Switch label="Semantic search" checked={settings['search.semantic'] === 'on'} onChange={on => set('search.semantic', on ? 'on' : 'off')} />
          <label className="setting-label">Rerank top results</label>
          <Select
            label="Rerank top results"
            value={settings['search.rerank'] ?? 'auto'}
            options={RERANK}
            onChange={value => set('search.rerank', value)}
          />
        </>
      )}
    </section>
  )
}
