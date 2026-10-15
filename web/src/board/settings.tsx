import type { BoardState, ViewPreferences } from '../../../src/core/model.ts'
import { VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import { boardConfig } from '../../../src/core/hydra.ts'
import { Button, Input, NumberField, Select, Switch } from '../components/ui/controls.tsx'
import { KeyboardSettings } from '../keyboard/settings.tsx'
import { columnsFor } from './view.ts'
import type { Command } from './connection.ts'
import { resetWidths } from './search-catalog.ts'
import { SearchSettings } from './search-settings.tsx'
import { AgentKinds } from './agent-kinds.tsx'

export function Settings({ state, view, save, command, notify }: {
  state: BoardState
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  close(): void
  command: Command
  notify({ text }: { text: string }): void
}) {
  const board = boardConfig({ state })

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
          <Switch label="Last message on cards" checked={view.lastMessageOnCards} onChange={({ value }) => save({ patch: { lastMessageOnCards: value } })} />
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
          <label className="setting-label">Identity</label>
          <Input
            aria-label="Hydra identity"
            defaultValue={board.hydra.id}
            onBlur={e => {
              if (e.target.value !== board.hydra.id) {
                void command({ name: 'board', args: ['set', '--hydra', e.target.value, '--event-id', crypto.randomUUID()] }).catch(e => notify({ text: e.message }))
              }
            }}
          />
          <label className="setting-label">Default model</label>
          <Input
            aria-label="Hydra default model"
            defaultValue={board.agents?.hydra?.model ?? ''}
            placeholder="Harness default"
            onBlur={e => {
              if (e.target.value !== (board.agents?.hydra?.model ?? '')) {
                void command({ name: 'kind', args: ['set', 'hydra', '--harness', board.agents?.hydra?.harness ?? 'claude', '--model', e.target.value] }).catch(e => notify({ text: e.message }))
              }
            }}
          />
        </section>
        <AgentKinds state={state} command={command} notify={notify} />
        <SearchSettings command={command} notify={notify} />
      </div>
      <KeyboardSettings prefs={view.keyboard} save={save} />
    </section>
  )
}
