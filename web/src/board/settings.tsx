import type { BoardState, ViewPreferences } from '../../../src/core/model.ts'
import { VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import { Button, NumberField, Select, Switch } from '../components/ui/controls.tsx'
import { KeyboardSettings } from '../keyboard/settings.tsx'
import { columnsFor } from './view.ts'
import type { Command } from './connection.ts'
import { SearchSettings } from './search-settings.tsx'
import { AgentKinds } from './agent-kinds.tsx'

export function Settings({
  state,
  view,
  save,
  close,
  command,
  notify,
}: {
  state: BoardState
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  close(): void
  command: Command
  notify({ text }: { text: string }): void
}) {
  return (
    <section className="settings" aria-label="Settings">
      <div className="row between">
        <div>
          <span className="eyebrow">MAKE ROOM FOR YOUR WORK</span>
          <h1 data-settings-heading tabIndex={-1}>Settings</h1>
          <p className="muted">Preferences follow this board across tabs.</p>
        </div>
        <Button variant="surface" onClick={close}>Back to board</Button>
      </div>
      <div className="settings-grid">
        <section className="settings-box">
          <h2>Reading & conversation</h2>
          <p className="muted">Keep the conversation beside your work, or open it in its column.</p>
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
              onChange={({ value: n }) => save({ patch: { [key]: n } })}
            />
          ))}
          <label className="setting-label">Conversation placement</label>
          <Select
            label="Conversation placement"
            value={view.panelPlacement}
            options={[{ value: 'right', label: 'Right panel' }, { value: 'inline', label: 'Inline with cards' }]}
            onChange={({ value: panelPlacement }) => save({ patch: { panelPlacement } })}
          />
          <NumberField
            label="Panel width"
            value={view.panelWidth}
            min={VIEW_SIZE_LIMITS.panelWidth.min}
            max={VIEW_SIZE_LIMITS.panelWidth.max}
            onChange={({ value: panelWidth }) => save({ patch: { panelWidth } })}
          />
          <NumberField
            label="Composer height"
            value={view.composerHeight}
            min={VIEW_SIZE_LIMITS.composerHeight.min}
            max={VIEW_SIZE_LIMITS.composerHeight.max}
            onChange={({ value: composerHeight }) => save({ patch: { composerHeight } })}
          />
        </section>
        <section className="settings-box">
          <h2>Cards & details</h2>
          <p className="muted">Resize an individual card on the board. Focus shows only prompts and agent messages, unless a card has an override.</p>
          <NumberField
            label="Default card height"
            value={view.cardHeight}
            min={VIEW_SIZE_LIMITS.cardHeight.min}
            max={VIEW_SIZE_LIMITS.cardHeight.max}
            onChange={({ value: cardHeight }) => save({ patch: { cardHeight } })}
          />
          <Switch label="Card accent colors" checked={view.cardColors} onChange={({ value: cardColors }) => save({ patch: { cardColors } })} />
          <Switch label="Focus by default" checked={!view.toolDetails && !view.thinkingDetails} onChange={({ value: focus }) => save({ patch: { toolDetails: !focus, thinkingDetails: !focus } })} />
        </section>
        <section className="settings-box">
          <h2>Column widths</h2>
          <p className="muted">Drag a boundary or focus it and use arrow keys. Shift moves in larger steps.</p>
          {columnsFor({ state }).map(c => (
            <NumberField
              key={c.id}
              label={c.title}
              value={view.columnWidths[c.id] ?? 290}
              min={VIEW_SIZE_LIMITS.columnWidth.min}
              max={VIEW_SIZE_LIMITS.columnWidth.max}
              onChange={({ value: n }) => save({ patch: { columnWidths: { [c.id]: n } } })}
            />
          ))}
        </section>
        <AgentKinds state={state} command={command} notify={notify} />
        <SearchSettings command={command} notify={notify} />
        <section className="settings-box">
          <h2>About this board</h2>
          <p className="muted">Every saved preference is part of the board history. Source facts and manual placement stay separate.</p>
          <dl>
            <dt>Last event</dt>
            <dd>{state.seq}</dd>
            <dt>View revision</dt>
            <dd>{state.viewRevision ?? 0}</dd>
            <dt>Keyboard</dt>
            <dd>
              Use Commands to discover actions and Keyboard shortcuts below to change bindings.
            </dd>
          </dl>
        </section>
      </div>
      <KeyboardSettings prefs={view.keyboard} save={save} />
    </section>
  )
}
