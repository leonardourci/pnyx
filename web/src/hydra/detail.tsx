import { InlinePermissions } from './permissions.tsx'
import { InlineQuestions } from './questions.tsx'
import { TaskUpdates } from './task-updates.tsx'
import { ReminderEditor } from './reminder.tsx'
import { useState } from 'react'
import type { HydraState, Card } from '../../../src/core/model.ts'
import { Button, Input } from '../components/ui/controls.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import { CopyId } from '../components/ui/copy-id.tsx'
import { HideAfter } from './hide-after.tsx'
import { Menu } from '../components/ui/menu.tsx'
import { columnsFor } from './view.ts'
import { useStartRequest } from './start-request.ts'
import type { Command } from './connection.ts'

export function Detail({
  card,
  state,
  command,
  connected,
  close,
  notify,
}: {
  card: Card
  state: HydraState
  command: Command
  connected: boolean
  close(): void
  notify({ text }: { text: string }): void
}) {
  const [
    reminding,
    setReminding,
  ] = useState(false)
  const [
    renaming,
    setRenaming,
  ] = useState(false)
  const {
    start,
    resume,
    busy: starting,
  } = useStartRequest({
    card,
    firstmate: state.config?.hydra.kind === 'firstmate',
    command,
    notify,
  })

  return (
    <section aria-label={`Details for ${card.title}`} className="detail inline">
      <header className="detail-header">
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
                onClick={async () => {
                  try {
                    await command({
                      name: 'task',
                      args: [
                        card.hidden ? 'unhide' : 'hide',
                        card.id,
                        '--event-id',
                        crypto.randomUUID(),
                      ],
                    })
                    close()
                  } catch (error) {
                    notify({ text: (error as Error).message })
                  }
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
          </Menu>

        </div>
      </header>
      {card.launch?.dispatch && <p className="muted small" aria-label="Heads dispatch choice">{card.launch.dispatch}</p>}
      {renaming && (
        <InlineTitle
          value={card.title}
          label="Task title"
          finished={() => setRenaming(false)}
          startEditing
          save={async ({ title }) => {
            await command({
              name: 'task',
              args: [
                'rename',
                card.id,
                '--title',
                title,
                '--event-id',
                crypto.randomUUID(),
              ],
            })
            setRenaming(false)
          }}
        />
      )}
      {renaming && (
        <Input
          key={card.project}
          aria-label="Task project label"
          defaultValue={card.project ?? ''}
          placeholder="Project label"
          onBlur={async e => {
            if (e.target.value !== (card.project ?? '')) {
              try {
                await command({
                  name: 'task',
                  args: [
                    'rename',
                    card.id,
                    '--project',
                    e.target.value,
                    '--event-id',
                    crypto.randomUUID(),
                  ],
                })
              } catch (error) {
                notify({ text: (error as Error).message })
              }
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
      <div className="task-requests">
        <InlinePermissions
          card={card}
          command={command}
          notify={notify}
          pendingOnly
        />
        <InlineQuestions
          card={card}
          command={command}
          notify={notify}
          pendingOnly
        />
      </div>
      <div className="detail-footer">
        <Button disabled={!connected || starting} onClick={resume}>Ask Hydra to resume</Button>
        <Button aria-label="Close detail" onClick={close}>Collapse ⌃</Button>
      </div>
      <TaskUpdates
        card={card}
        columns={columnsFor({ state })}
        command={command}
        connected={connected}
      />
    </section>
  )
}
