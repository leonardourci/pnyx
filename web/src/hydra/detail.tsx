import { TaskUpdates } from './task-updates.tsx'
import { ReminderEditor } from './reminder.tsx'
import { useState } from 'react'
import type { HydraState, Card } from '../../../src/core/model.ts'
import { Button, Input } from '../components/ui/controls.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import { CopyId } from '../components/ui/copy-id.tsx'
import { HideAfter } from './hide-after.tsx'
import { Menu } from '../components/ui/menu.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { harnessName } from './agent-settings.tsx'
import { useStartRequest } from './start-request.ts'
import type { Command } from './connection.ts'

export function Detail({
  card,
  state,
  command,
  connected,
  close,
  createTask,
  notify,
}: {
  card: Card
  state: HydraState
  command: Command
  connected: boolean
  close(): void
  createTask({ column, parent }: { column: string; parent?: string }): void
  notify({ text }: { text: string }): void
}) {
  const [reminding, setReminding] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const { start, resume, reassign, busy: starting } = useStartRequest({ card, firstmate: state.config?.hydra.kind === 'firstmate', command, notify })

  return (
    <section aria-label={`Details for ${card.title}`} className="detail inline">
      <header className="detail-header">
        {card.agent && <span className="agent-chip">{`${harnessName({ provider: card.agent.provider })}${card.agent.host === 'pnyx' ? ' · Pnyx' : card.terminal?.tty ? ' · terminal' : ''}`}</span>}
        <div className="row">
          <Menu label="Task menu">
            <CopyId id={card.id} notify={notify} />
            <HideAfter
              card={card}
              command={command}
              connected={connected}
              notify={notify}
            />
            <Button onClick={() => setRenaming(true)}>Rename task</Button>
            {!card.automaticTask && (
              <Button disabled={!connected} onClick={() => setReminding(true)}>Remind me…</Button>
            )}
            {!card.automaticTask && (
              <Button
                disabled={!connected}
                onClick={() => {
                  void command({ name: 'task', args: [card.hidden ? 'unhide' : 'hide', card.id, '--event-id', crypto.randomUUID()] })
                    .catch(e => notify({ text: e.message }))
                  close()
                }}
              >{card.hidden ? 'Bring back to Hydra' : 'Hide from Hydra'}
              </Button>
            )}
            {!card.agent && (
              <Button disabled={!connected || starting} onClick={start}>{starting ? 'Requesting…' : 'Start'}</Button>
            )}
            {card.agent && (
              <Button disabled={!connected || starting} onClick={resume}>Resume</Button>
            )}
            {card.agent && (
              <Button disabled={!connected || starting} onClick={reassign}>Reassign</Button>
            )}
            {!card.parentId && (
              <Button
                disabled={!connected}
                onClick={() => createTask({ column: card.column, parent: card.id })}
              >Add subtask
              </Button>
            )}
          </Menu>
          <Button aria-label="Close detail" onClick={close}><Icon name="close" size={14} /></Button>
        </div>
      </header>
      {card.launch?.dispatch && <p className="muted small" aria-label="Heads dispatch choice">{card.launch.dispatch}</p>}
      {renaming && (
        <InlineTitle
          value={card.title}
          label="Task title"
          finished={() => setRenaming(false)}
          startEditing
          save={({ title }) => command({ name: 'task', args: ['rename', card.id, '--title', title, '--event-id', crypto.randomUUID()] }).then(() => setRenaming(false))}
        />
      )}
      {renaming && (
        <Input
          key={card.project}
          aria-label="Task project label"
          defaultValue={card.project ?? ''}
          placeholder="Project label"
          onBlur={e => {
            if (e.target.value !== (card.project ?? '')) {
              void command({ name: 'task', args: ['rename', card.id, '--project', e.target.value, '--event-id', crypto.randomUUID()] }).catch(e => notify({ text: e.message }))
            }
          }}
        />
      )}
      {reminding && (
        <ReminderEditor
          card={card}
          command={command}
          connected={connected}
          close={() => setReminding(false)}
        />
      )}
      <TaskUpdates card={card} command={command} connected={connected} />
    </section>
  )
}
