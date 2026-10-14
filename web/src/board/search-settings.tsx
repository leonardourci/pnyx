import { useEffect, useState } from 'react'
import type { Command } from './connection.ts'
import { Switch } from '../components/ui/controls.tsx'

type Entries = Record<string, string>

// This machine's search settings, shared by every board; models are downloaded once from the CLI.
export function SearchSettings({ command, notify }: {
  command: Command
  notify(text: string): void
}) {
  const [settings, setSettings] = useState<Entries | null>(null)
  useEffect(() => {
    void command('settings', []).then(r => setSettings(r.settings as Entries))
      .catch(e => notify(e.message))
  }, [command, notify])
  const set = (key: string, on: boolean) => command('settings', ['set', key, on ? 'on' : 'off']).then(r => {
    setSettings(r.settings as Entries); notify('Search settings saved')
  }, e => notify(e.message))

  return (
    <section className="settings-box" aria-label="Search"><h2>Search</h2><p className="muted">Find cards by meaning, in any language, as well as by words. Runs local models on this machine; download them once with <code>pnyx-axi search setup --semantic</code>. Turn it off on a slow laptop.</p>
      {settings && <><Switch label="Semantic search" checked={settings['search.semantic'] === 'on'} onChange={on => set('search.semantic', on)} /><Switch label="Rerank top results (best with a GPU)" checked={settings['search.rerank'] === 'on'} onChange={on => set('search.rerank', on)} /></>}
    </section>
  )
}
