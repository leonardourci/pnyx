import type { Ask, Card } from '#tasks/model.ts'
import { askWording } from '#tasks/questions.ts'
import { TaskReference } from '#web-tasks/task-reference.tsx'
import { Disclosure, CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { AskPanel } from '#web-tasks/ask.tsx'
import { clock } from './chat.ts'
import type { Command } from '#web-app/connection.ts'

export interface ChatDecision {
  id: string
  at: string
  card: Card
  ask: Ask
}

export const chatDecisions = ({ cards }: { cards: Card[] }): ChatDecision[] => cards.flatMap(card =>
  (card.asks ?? []).filter(ask => ask.audience === 'owner' && !ask.closed).map(ask => ({
    id: `ask:${card.id}:${ask.id}`,
    at: ask.escalated?.at ?? ask.at,
    card,
    ask,
  })))

export function ChatDecisionCard({
  decision,
  command,
  notify,
}: {
  decision: ChatDecision
  command: Command
  notify({ text }: { text: string }): void
}) {
  const {
    card,
    ask,
  } = decision

  return (
    <div className="chat-decision" contentEditable={ask.answered ? false : undefined}>
      <TaskReference id={card.id} />
      {ask.answered ? (
        <Decided
          card={card}
          ask={ask}
          command={command}
          notify={notify}
        />
      ) : (
        <AskPanel
          card={card}
          ask={ask}
          command={command}
          notify={notify}
        />
      )}
    </div>
  )
}

function Decided({
  card,
  ask,
  command,
  notify,
}: {
  card: Card
  ask: Ask
  command: Command
  notify({ text }: { text: string }): void
}) {
  const decidedAt = ask.answeredAt ?? ask.fromMessage?.at
  const title = (
    <>Decided {decidedAt && clock({ at: decidedAt })}
      {ask.fromMessage && ' from your message'} · {askWording({ ask }).question}
    </>
  )

  if (!ask.fromMessage) {
    return <p className="decided">{title}</p>
  }

  return (
    <div className="decided">
      <Disclosure title={<>Recorded as your answer to ‘{askWording({ ask }).question}’</>}>
        <blockquote><CollapsibleText text={ask.fromMessage.text} /></blockquote>
      </Disclosure>
      <Button
        onClick={async () => {
          try {
            await command({
              name: 'task',
              args: [
                'reopen-question',
                card.id,
                ask.id,
                '--answer',
                ask.answered ?? '',
              ],
            })
            notify({ text: 'Question reopened.' })
          } catch (error) {
            notify({ text: String(error) })
          }
        }}
      >Undo answer
      </Button>
    </div>
  )
}
