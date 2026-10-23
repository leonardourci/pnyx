import { Disclosure } from '../components/ui/disclosure.tsx'
import { Markdown } from '../components/ui/markdown.tsx'
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
      {card.ask?.length ? (
        <section className="task-intent" aria-label="Owner's ask">
          <strong>Owner's ask</strong>
          {card.ask.map((
            entry,
            index,
          ) => (
            <article key={`${entry.at}-${index}`}>
              <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
              <Markdown text={entry.text} />
            </article>
          ))}
        </section>
      ) : null}
      {card.brief ? (
        <Disclosure title="Hydra's build instructions">
          <Markdown text={card.brief} />
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
