import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { TaskReference } from '#web-tasks/task-reference.tsx'
import { clock,copiedText,duration,type TurnTiming } from './chat.ts'
import type { TurnActions } from '#hydra/conversation.ts'

import { CollapsibleText,Disclosure } from '#web-shared/ui/disclosure.tsx'
import { UpdateEntry } from '#web-tasks/update-rows.tsx'

export function TurnActionsFold({ fold }: { fold: TurnActions }) {
  const changes = fold.tasks.reduce(
    (
      count,
      task,
    ) => count + task.updates.length,
    0,
  )
  let label = <>Hydra’s progress · {fold.notes.length} notes</>

  if (fold.tasks.length) {
    const tasks = fold.tasks.length === 1
      ? <>{fold.tasks[0]!.title}</>
      : <>{fold.tasks.length} tasks</>
    label = <>Hydra acted on {tasks} · {changes} {changes === 1 ? 'change' : 'changes'}</>
  }

  return (
    <div contentEditable={false} className="turn-actions">
      <Disclosure title={label}>
        {fold.notes.length > 0 && (
          <section className="turn-progress">
            <span className="eyebrow">Progress notes</span>
            {fold.notes.map(note => <CollapsibleText key={note.id} text={note.text} />)}
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
  taskTitle({ id }: { id?: string }): string | undefined
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
            title: taskTitle({ id: turn.task }),
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
