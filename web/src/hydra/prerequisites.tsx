import type { HydraState } from '../../../src/app/model.ts'
import type { Card } from '../../../src/tasks/model.ts'
import { taskReadiness } from '../../../src/tasks/dependencies.ts'
import { TaskReference } from '../components/ui/task-reference.tsx'

export function Prerequisites({
  card,
  state,
}: {
  card: Card
  state: HydraState
}) {
  if (!card.prerequisites?.length) {
    return null
  }

  const readiness = taskReadiness({
    state,
    card,
  })

  return (
    <section aria-label="Prerequisites">
      <h3>Prerequisites</h3>
      <ul>
        {card.prerequisites.map(id => {
          const unmet = readiness.unmet.find(item => item.id === id)

          return (
            <li key={id}>
              <TaskReference id={id} />
              <span>{unmet ? ` Waiting: ${unmet.reason}` : ' Complete'}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
