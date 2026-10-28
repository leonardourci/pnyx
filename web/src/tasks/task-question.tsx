import type { Card } from '../../../src/tasks/model.ts'
import { answerPrompt } from '../../../src/workers/answers.ts'
import { CollapsibleText } from '../shared/ui/disclosure.tsx'
import { Button } from '../shared/ui/controls.tsx'
import { InlinePermissions } from '../workers/permissions.tsx'
import { InlineQuestions } from './questions.tsx'
import { AskPanel } from './ask.tsx'
import { openAsks } from '../../../src/tasks/questions.ts'
import type { Command } from '../app/connection.ts'

export const hasTaskQuestion = ({
  card,
}: {
  card: Card
}) =>
  card.permissions?.some(request => request.status === 'pending')
  || card.attention.some(request => request.blocking && !request.answered)
  || openAsks({
    card,
    audience: 'owner',
  }).length > 0

export function TaskQuestion({
  card,
  command,
  notify,
  answer,
}: {
  card: Card
  command: Command
  notify({ text }: { text: string }): void
  answer({ card }: { card: Card }): void
}) {
  const permissions = card.permissions?.filter(request => request.status === 'pending') ?? []
  const attention = card.attention.find(request => request.blocking && !request.answered)
  const structured = card.attention.some(request => !request.answered && answerPrompt({
    card,
    request,
  }))
  const text = attention?.text
  const asks = openAsks({
    card,
    audience: 'owner',
  })

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
      {asks.map(ask => (
        <AskPanel
          key={ask.id}
          card={card}
          ask={ask}
          command={command}
          notify={notify}
        />
      ))}
      {!permissions.length && !structured && !asks.length && text && (
        <div className="pending-decision">
          <CollapsibleText text={text} />
          <div className="pending-decision-actions">
            <span className="muted small">Awaiting your answer</span>
            <Button variant="surface" onClick={() => answer({ card })}>Answer</Button>
          </div>
        </div>
      )}
    </div>
  )
}
