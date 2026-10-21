import type { Card } from '../../../src/core/model.ts'
import { answerPrompt } from '../../../src/core/answer.ts'
import { Button } from '../components/ui/controls.tsx'
import { InlinePermissions } from './permissions.tsx'
import { InlineQuestions } from './questions.tsx'
import type { Command } from './connection.ts'

export const hasTaskQuestion = ({ card }: { card: Card }) =>
  card.permissions?.some(request => request.status === 'pending')
  || card.attention.some(request => request.blocking && !request.answered)
  || card.status?.state === 'needs_you'

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
  const text = attention?.text || card.status?.note

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
      {!permissions.length && !structured && text && (
        <div className="card-question">
          <strong className="eyebrow">Question</strong>
          <p>{text}</p>
          <Button variant="primary" onClick={() => answer({ card })}>Answer</Button>
        </div>
      )}
    </div>
  )
}
