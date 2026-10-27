import { useOraclePreferences } from './oracle-preferences.ts'
import type { Command } from './connection.ts'
import { Select, Switch } from '../shared/ui/controls.tsx'

const RERANK = [
  {
    value: 'auto',
    label: 'Auto: on with a GPU',
  },
  {
    value: 'on',
    label: 'On',
  },
  {
    value: 'off',
    label: 'Off',
  },
]

export function OracleSettings({
  command,
  notify,
}: {
  command: Command
  notify({ text }: { text: string }): void
}) {
  const {
    settings,
    set: persist,
    error,
  } = useOraclePreferences({
    command,
    notify,
  })
  const set = ({
    key,
    value,
  }: {
    key: string
    value: string
  }) => persist({
    key,
    value,
  })
    .then(
      () => notify({ text: 'Oracle settings saved' }),
      e => notify({ text: e.message }),
    )

  return (
    <section className="settings-box" aria-label="Oracle">
      <h2>Oracle</h2>
      <p className="muted">
        Every search finds cards by meaning, in any language, as well as by words. It runs
        local models on this machine, downloaded on first use. Turn it off on a slow laptop.
      </p>
      {!settings && !error && <p className="muted" role="status">Loading Oracle settings…</p>}
      {error && <p role="alert">{error}</p>}
      {settings && (
        <>
          <Switch
            label="Semantic search"
            checked={settings['oracle.semantic'] === 'on'}
            onChange={({ value: on }) => set({
              key: 'oracle.semantic',
              value: on ? 'on' : 'off',
            })}
          />
          <label className="setting-label">Rerank top results</label>
          <Select
            label="Rerank top results"
            value={settings['oracle.rerank'] ?? 'auto'}
            options={RERANK}
            onChange={({ value }) => set({
              key: 'oracle.rerank',
              value,
            })}
          />
        </>
      )}
    </section>
  )
}
