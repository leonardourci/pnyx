import type { Ask, Card } from '../../../src/core/model.ts'
import { askWording } from '../../../src/core/asks.ts'
import { TaskReference } from '../components/ui/task-reference.tsx'
import { Disclosure, CollapsibleText } from '../components/ui/disclosure.tsx'
import { Button } from '../components/ui/controls.tsx'
import { AskPanel } from './ask.tsx'
import { clock } from './chat.ts'
import type { Command } from './connection.ts'

export interface ChatDecision {
  id: string
  at: string
  card: Card
  ask: Ask
}

export const chatDecisions = ({ cards }: { cards: Card[] }): ChatDecision[] => cards.flatMap(card =>
  (card.asks ?? []).filter(ask => ask.audience === 'owner').map(ask => ({
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
    <div className="chat-decision" contentEditable={false}>
      <TaskReference id={card.id} />
      {ask.answered ? <Decided ask={ask} /> : (
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

function Decided({ ask }: { ask: Ask }) {
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
    <Disclosure className="decided" title={title}>
      <blockquote><CollapsibleText text={ask.fromMessage.text} /></blockquote>
    </Disclosure>
  )
}

export function WaitingDecisions({
  decisions,
  jump,
  loading,
}: {
  decisions: ChatDecision[]
  jump({ decision }: { decision: ChatDecision }): Promise<void>
  loading: boolean
}) {
  if (!decisions.length) {
    return null
  }

  return (
    <div className="waiting-decisions" aria-label="Decisions waiting">
      <span>{decisions.length} {decisions.length === 1 ? 'decision' : 'decisions'} waiting</span>
      {decisions.map(decision => (
        <Button
          key={decision.id}
          disabled={loading}
          title={askWording({ ask: decision.ask }).question}
          onClick={async () => {
            await jump({ decision })
          }}
        >
          {decision.card.title}
        </Button>
      ))}
    </div>
  )
}
