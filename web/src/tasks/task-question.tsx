import type { Card } from '#tasks/model.ts'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { InlinePermissions } from '#web-workers/permissions.tsx'
import { InlineQuestions } from './questions.tsx'
import { AskPanel } from './ask.tsx'
import type { Command } from '#web-app/connection.ts'
import { genericPrompts } from './view.ts'
import { AnsweredQuestions, recordedAnswers } from './answered-questions.tsx'
import type { HydraState } from '#app/model.ts'
import { taskQuestions } from './task-question.ts'
import { ReviewReadiness } from './review-readiness.tsx'

export function TaskQuestion({
  card,
  connected,
  state,
  command,
  notify,
  answer,
}: {
  card: Card
  state?: HydraState
  connected: boolean
  command: Command
  notify({ text }: { text: string }): void
  answer({ card }: { card: Card }): void
}) {
  const permissions = card.permissions?.filter(request => request.status === 'pending') ?? []
  const {
    questions,
    reviews,
    asks,
  } = taskQuestions({
    state,
    card,
  })
  const prompts = genericPrompts({ card })

  if (!questions.length && !recordedAnswers({ card }).length && !reviews.length) {
    return null
  }

  return (
    <div className="task-requests">
      <InlinePermissions
        card={{
          ...card,
          permissions,
        }}
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
      {reviews.map(request => (
        <ReviewReadiness
          key={request.ask.id}
          request={request}
          connected={connected}
          command={command}
          notify={notify}
        />
      ))}
      {asks.map(ask => (
        <AskPanel
          key={ask.id}
          card={card}
          ask={ask}
          command={command}
          notify={notify}
        />
      ))}
      <AnsweredQuestions card={card} command={command} notify={notify} />
      {prompts.map(question => (
        <div key={question.attention!.key} className="pending-decision">
          <CollapsibleText text={question.text} />
          <div className="pending-decision-actions">
            <span className="muted small">Awaiting your answer</span>
            <Button variant="surface" onClick={() => answer({ card })}>Answer</Button>
          </div>
        </div>
      ))}
    </div>
  )
}
