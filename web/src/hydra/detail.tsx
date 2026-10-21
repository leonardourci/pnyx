import { InlinePermissions } from './permissions.tsx'
import { InlineQuestions } from './questions.tsx'
import { TaskUpdates } from './task-updates.tsx'
import type { HydraState, Card } from '../../../src/core/model.ts'
import { columnsFor } from './view.ts'
import type { Command } from './connection.ts'

export function Detail({
  card,
  state,
  command,
  connected,
  notify,
}: {
  card: Card
  state: HydraState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  return (
    <section aria-label={`Details for ${card.title}`} className="detail inline">
      {card.launch?.dispatch && <p className="muted small" aria-label="Heads dispatch choice">{card.launch.dispatch}</p>}
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
      <TaskUpdates
        card={card}
        columns={columnsFor({ state })}
        command={command}
        connected={connected}
      />
    </section>
  )
}
