import { Prerequisites } from './prerequisites.tsx'
import { CollapsibleText, Disclosure } from '../components/ui/disclosure.tsx'
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
      {card.brief ? (
        <Disclosure title="Hydra's build instructions">
          <CollapsibleText text={card.brief} />
        </Disclosure>
      ) : null}
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
