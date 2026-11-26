import { MessageFooter } from './message-surface.tsx'
import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { TaskReference } from '#web-tasks/task-reference.tsx'
import { clock,copiedText,duration } from './chat.ts'
import type { TurnTiming } from '#titan/chat-messages.ts'
import type { TurnActions } from '#titan/conversation.ts'

import { CollapsibleText,Disclosure } from '#web-shared/ui/disclosure.tsx'
import { UpdateEntry } from '#web-tasks/update-rows.tsx'
import type { OthrysLookup } from './othrys-action.ts'
import { progressRows } from './progress-rows.ts'
import { ProgressTrace } from './trace-row.tsx'

// A running turn's progress moves from after Titan's latest message to before its reply; an open fold stays open.
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
  lookup: OthrysLookup
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
  let label = <>Titan’s progress · {rows.length} {rows.length === 1 ? 'update' : 'updates'}</>

  if (fold.tasks.length) {
    const tasks = fold.tasks.length === 1
      ? <>{fold.tasks[0]!.title}</>
      : <>{fold.tasks.length} tasks</>
    label = <>Titan acted on {tasks} · {changes} {changes === 1 ? 'change' : 'changes'}</>
  }

  return (
    <div className="turn-actions mt-0.5 mx-0 mb-3 text-muted text-meta [&>.disclosure>summary]:text-[length:inherit] [&>.disclosure>summary]:justify-start [&>.disclosure>summary]:gap-1.25 [&>.disclosure>summary]:p-0 [&>.disclosure>summary>.disclosure-chevron]:ml-0 [&>.disclosure>summary>.disclosure-chevron]:opacity-0 [&>.disclosure>summary>.disclosure-chevron]:transition-opacity [&>.disclosure>summary>.disclosure-chevron]:duration-fast [&>.disclosure>summary>.disclosure-chevron]:ease-ui [&>.disclosure:is([open],:hover,:focus-within)>summary>.disclosure-chevron]:opacity-100 [&>.disclosure>.disclosure-body]:pt-2.5 [&>.disclosure>.disclosure-body]:px-0 [&>.disclosure>.disclosure-body]:pb-0">
      <Disclosure
        title={label}
        open={opened !== undefined && OPENED_PROGRESS.has(opened)}
        onToggle={({ open }) => rememberOpen({
          id: opened,
          open,
        })}
      >
        {rows.length > 0 && (
          <section className="turn-progress mb-3 [&_.collapsible-text]:mt-1.5">
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
          <section key={task.task} className="turn-task [&+.turn-task]:border-t [&+.turn-task]:border-line [&+.turn-task]:mt-3 [&+.turn-task]:pt-3">
            <TaskReference id={task.task} />
            <div className="turn-task-updates mt-2 [&_.update-title]:font-normal [&_.update-main]:text-ink">
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
    <MessageFooter variant="agent">
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
    </MessageFooter>
  )
}
