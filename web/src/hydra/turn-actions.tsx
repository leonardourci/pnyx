import { Disclosure, CollapsibleText } from '../shared/ui/disclosure.tsx'
import { TaskReference } from '../components/ui/task-reference.tsx'
import { UpdateEntry } from './update-rows.tsx'
import type { TurnActions } from './conversation.ts'

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
