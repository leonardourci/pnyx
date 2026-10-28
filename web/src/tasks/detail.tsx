import { Prerequisites } from './prerequisites.tsx'
import { TaskUpdates } from './task-updates.tsx'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { columnsFor } from './view.ts'
import type { Command } from '#web-app/connection.ts'

export function Detail({
  card,
  state,
  command,
  connected,
  notify,
  answer,
}: {
  card: Card
  state: HydraState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
  answer({ card }: { card: Card }): void
}) {
  return (
    <section aria-label={`Details for ${card.title}`} className="detail inline">
      <Prerequisites card={card} state={state} />
      <TaskUpdates
        card={card}
        columns={columnsFor({ state })}
        command={command}
        connected={connected}
        notify={notify}
        answer={answer}
      />
    </section>
  )
}
