import type { Card } from '#tasks/model.ts'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { InlinePermissions } from '#web-workers/permissions.tsx'
import { InlineQuestions } from './questions.tsx'
import { AskPanel } from './ask.tsx'
import { ownerQuestions } from '#tasks/questions.ts'
import type { Command } from '#web-app/connection.ts'
import { genericPrompts } from './view.ts'

export const hasTaskQuestion = ({ card }: { card: Card }) => ownerQuestions({ card }).length > 0

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
  const asks = ownerQuestions({ card }).flatMap(question => question.ask ? [question.ask] : [])
  const prompts = genericPrompts({ card })

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
