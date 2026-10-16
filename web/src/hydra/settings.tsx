import { useHeadsDispatch } from './heads-dispatch.ts'
import { Projects } from './projects.tsx'
import type { HydraState, ViewPreferences } from '../../../src/core/model.ts'
import { VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import { hydraConfig } from '../../../src/core/hydra.ts'
import { Button, Input, NumberField, Select, Switch } from '../components/ui/controls.tsx'
import { DEFAULT_DONE_HOURS, MAX_DONE_HOURS } from '../../../src/core/retention.ts'
import { KeyboardSettings } from '../keyboard/settings.tsx'
import { columnsFor } from './view.ts'
import type { Command } from './connection.ts'
import { resetWidths } from './oracle-catalog.ts'
import { OracleSettings } from './oracle-settings.tsx'
import { AgentKinds } from './agent-kinds.tsx'
import { IntegrationSettings } from './integrations.tsx'
import { About } from './about.tsx'

export function Settings({ state, connected, view, save, command, notify }: {
  state: HydraState
  connected: boolean
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  close(): void
  command: Command
  notify({ text }: { text: string }): void
}) {
  const { effective } = useHeadsDispatch({ command, seq: state.seq })
  const hydraAgent = effective?.dispatch.rules.hydra?.candidates[0]
  const config = hydraConfig({ state })

  return (
    <section className="settings" aria-label="Settings">
      <h1 data-settings-heading tabIndex={-1}>Settings</h1>
      <div className="settings-grid">
        <section className="settings-box">
          <h2>Appearance</h2>
          <label className="setting-label">Theme</label>
          <Select
            label="Theme"
            value={view.theme}
            options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
            onChange={({ value: theme }) => save({ patch: { theme } })}
          />
          {([['fontSize', 'UI font size'], ['chatFontSize', 'Chat font size'], ['codeFontSize', 'Code font size']] as const).map(([key, label]) => (
            <NumberField
              key={key}
              label={label}
              step={1}
              value={view[key]}
              min={VIEW_SIZE_LIMITS[key].min}
              max={VIEW_SIZE_LIMITS[key].max}
              onChange={({ value }) => save({ patch: { [key]: value } })}
            />
          ))}
          <Switch label="Agent updates on cards" checked={view.lastMessageOnCards} onChange={({ value }) => save({ patch: { lastMessageOnCards: value } })} />
        </section>
        <section className="settings-box">
          <h2>Conversations</h2>
          <Switch label="Focus mode" checked={view.focusMode} onChange={({ value }) => save({ patch: { focusMode: value } })} />
          <p className="muted">Hide tool calls and thinking.</p>
          <Switch label="Tool call details" checked={view.toolDetails} onChange={({ value }) => save({ patch: { toolDetails: value } })} />
          <p className="muted">Expand tool rows to read their details.</p>
          <Switch label="Thinking details" checked={view.thinkingDetails} onChange={({ value }) => save({ patch: { thinkingDetails: value } })} />
          <p className="muted">Expand thinking rows to read their details.</p>
        </section>
        <section className="settings-box">
          <h2>Column template</h2>
          {columnsFor({ state }).map(column => (
            <div className="column-template" key={column.id}>
              <label className="setting-label">{column.title}</label>
              <Input
                aria-label={`${column.title} description`}
                defaultValue={column.description ?? ''}
                onBlur={e => {
                  if (e.target.value !== (column.description ?? '')) {
                    void command({ name: 'column', args: ['describe', column.id, '--description', e.target.value, '--event-id', crypto.randomUUID()] }).catch(e => notify({ text: e.message }))
                  }
                }}
              />
            </div>
          ))}
          <Button variant="surface" onClick={() => save({ patch: resetWidths({ view }) })}>Reset widths to defaults</Button>
        </section>
        <section className="settings-box">
          <h2>Hydra</h2>
          <label className="setting-label">Hide Done cards after (hours)</label>
          <Input
            key={config.doneAfterHours ?? DEFAULT_DONE_HOURS}
            aria-label="Hide Done cards after hours"
            type="number"
            min="0"
            max={MAX_DONE_HOURS}
            step="any"
            defaultValue={config.doneAfterHours ?? DEFAULT_DONE_HOURS}
            onBlur={e => {
              if (e.target.value !== String(config.doneAfterHours ?? DEFAULT_DONE_HOURS)) {
                void command({ name: 'hydra', args: ['set', '--done-after-hours', e.target.value, '--event-id', crypto.randomUUID()] }).catch(e => notify({ text: e.message }))
              }
            }}
          />
          <p className="muted small">0 keeps Done cards visible. Hidden cards stay in History and Oracle and can be brought back.</p>
          <label className="setting-label">Identity</label>
          <Input
            aria-label="Hydra identity"
            defaultValue={config.hydra.id}
            onBlur={e => {
              if (e.target.value !== config.hydra.id) {
                void command({ name: 'hydra', args: ['set', '--identity', e.target.value, '--event-id', crypto.randomUUID()] }).catch(e => notify({ text: e.message }))
              }
            }}
          />
          <label className="setting-label">Default model</label>
          <Input
            aria-label="Hydra default model"
            defaultValue={hydraAgent?.model ?? ''}
            placeholder="Harness default"
            onBlur={e => {
              if (e.target.value !== (hydraAgent?.model ?? '')) {
                void command({ name: 'rule', args: ['set', 'hydra', '--harness', hydraAgent?.harness ?? 'claude', '--model', e.target.value] }).catch(e => notify({ text: e.message }))
              }
            }}
          />
        </section>
        <Projects
          state={state}
          connected={connected}
          command={command}
          notify={notify}
        />
        <AgentKinds state={state} command={command} notify={notify} />
        <OracleSettings command={command} notify={notify} />
        <IntegrationSettings command={command} notify={notify} />
        <About />
      </div>
      <KeyboardSettings prefs={view.keyboard} save={save} />
    </section>
  )
}
