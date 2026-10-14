import type { BoardState, ViewPreferences } from '../../../src/core/model.ts'
import { Button, NumberField, Select, Switch } from '../components/ui/controls.tsx'
import { KeyboardSettings } from '../keyboard/settings.tsx'
import { columnsFor } from './view.ts'
import type { Command } from './connection.ts'
import { SearchSettings } from './search-settings.tsx'

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
  save(patch: unknown): Promise<boolean>
  close(): void
  command: Command
  notify(text: string): void
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
          <NumberField
            label="Font size"
            step={1}
            value={view.fontSize}
            min={12}
            max={20}
            onChange={fontSize => save({ fontSize })}
          />
          <label className="setting-label">Conversation placement</label>
          <Select
            label="Conversation placement"
            value={view.panelPlacement}
            options={[{ value: 'right', label: 'Right panel' }, { value: 'inline', label: 'Inline with cards' }]}
            onChange={panelPlacement => save({ panelPlacement })}
          />
          <NumberField
            label="Panel width"
            value={view.panelWidth}
            min={320}
            max={720}
            onChange={panelWidth => save({ panelWidth })}
          />
          <NumberField
            label="Composer height"
            value={view.composerHeight}
            min={140}
            max={420}
            onChange={composerHeight => save({ composerHeight })}
          />
        </section>
        <section className="settings-box">
          <h2>Cards & details</h2>
          <p className="muted">Resize an individual card on the board. Trace defaults apply unless a card has an override.</p>
          <NumberField
            label="Default card height"
            value={view.cardHeight}
            min={200}
            max={600}
            onChange={cardHeight => save({ cardHeight })}
          />
          <Switch label="Card accent colors" checked={view.cardColors} onChange={cardColors => save({ cardColors })} />
          <Switch label="Tool details by default" checked={view.toolDetails} onChange={toolDetails => save({ toolDetails })} />
          <Switch label="Thinking by default" checked={view.thinkingDetails} onChange={thinkingDetails => save({ thinkingDetails })} />
        </section>
        <section className="settings-box">
          <h2>Column widths</h2>
          <p className="muted">Drag a boundary or focus it and use arrow keys. Shift moves in larger steps.</p>
          {columnsFor(state).map(c => (
            <NumberField
              key={c.id}
              label={c.title}
              value={view.columnWidths[c.id] ?? 290}
              min={240}
              max={640}
              onChange={n => save({ columnWidths: { [c.id]: n } })}
            />
          ))}
        </section>
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
