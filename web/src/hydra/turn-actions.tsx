import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { TaskReference } from '#web-tasks/task-reference.tsx'
import { clock,copiedText,duration } from './chat.ts'
import type { TurnTiming } from '#hydra/chat-messages.ts'
import type { TurnActions } from '#hydra/conversation.ts'

import { CollapsibleText,Disclosure } from '#web-shared/ui/disclosure.tsx'
import { UpdateEntry } from '#web-tasks/update-rows.tsx'
import type { PnyxLookup } from './pnyx-action.ts'
import { progressRows } from './progress-rows.ts'
import { ProgressTrace } from './trace-row.tsx'

// A running turn's progress moves from after Hydra's latest message to before its reply; an open fold stays open.
const OPENED_PROGRESS = new Set<string>()

const rememberOpen = ({
  id,
  open,
}: {
  id?: string
  open: boolean
}) => {
  if (id === undefined) {
    return
  }

  if (open) {
    OPENED_PROGRESS.add(id)
  } else {
    OPENED_PROGRESS.delete(id)
  }
}

export function TurnActionsFold({
  fold,
  lookup,
  toolDetails = false,
  thinkingDetails = false,
}: {
  fold: TurnActions
  lookup: PnyxLookup
  toolDetails?: boolean
  thinkingDetails?: boolean
}) {
  const rows = progressRows({ notes: fold.notes })
  const opened = fold.notes[0]?.id

  if (!rows.length && !fold.tasks.length) {
    return null
  }

  const changes = fold.tasks.reduce(
    (
      count,
      task,
    ) => count + task.updates.length,
    0,
  )
  let label = <>Hydra’s progress · {rows.length} {rows.length === 1 ? 'update' : 'updates'}</>

  if (fold.tasks.length) {
    const tasks = fold.tasks.length === 1
      ? <>{fold.tasks[0]!.title}</>
      : <>{fold.tasks.length} tasks</>
    label = <>Hydra acted on {tasks} · {changes} {changes === 1 ? 'change' : 'changes'}</>
  }

  return (
    <div contentEditable={false} className="turn-actions">
      <Disclosure
        title={label}
        open={opened !== undefined && OPENED_PROGRESS.has(opened)}
        onToggle={({ open }) => rememberOpen({
          id: opened,
          open,
        })}
      >
        {rows.length > 0 && (
          <section className="turn-progress">
            <span className="eyebrow">Progress</span>
            {rows.map(row => (
              <div key={row.entry.id} data-progress-id={row.entry.reference ?? row.entry.id}>
                {row.kind === 'message'
                  ? <CollapsibleText text={row.entry.text} />
                  : (
                    <ProgressTrace
                      row={row}
                      open={row.kind === 'tool' ? toolDetails : thinkingDetails}
                      lookup={lookup}
                    />
                  )}
              </div>
            ))}
          </section>
        )}
        {fold.tasks.map(task => (
          <section key={task.task} className="turn-task">
            <TaskReference id={task.task} />
            <div className="turn-task-updates">
              {task.updates.map(update => <UpdateEntry key={update.id} update={update} />)}
            </div>
          </section>
        ))}

      </Disclosure>
    </div>
  )
}

export function TurnFooter({
  turn,
  taskTitle,
}: {
  turn: TurnTiming
  taskTitle?: string
}) {
  const took = duration({ ms: Date.parse(turn.end) - Date.parse(turn.start) })
  const started = clock({
    at: turn.start,
    seconds: true,
  })

  return (
    <div className="turn-foot" contentEditable={false}>
      {turn.reply && (
        <CopyButton
          label="Copy reply"
          text={() => copiedText({
            text: turn.reply,
            task: turn.task,
            title: taskTitle,
          })}
        />
      )}
      {turn.latest
        ? <time dateTime={turn.end} title={`Worked for ${took} · started ${started}`}>{clock({ at: turn.end })}</time>
        : (
          <span
            title={`Started ${started} · stopped ${clock({
              at: turn.end,
              seconds: true,
            })}`}
          >Worked for {took}
          </span>
        )}
    </div>
  )
}
