import { HYDRA_CARD } from '#hydra/identity.ts'
import { TaskReference } from '#web-tasks/task-reference.tsx'
import { AskPanel } from '#web-tasks/ask.tsx'
import { ReviewReadiness } from '#web-tasks/review-readiness.tsx'
import type { Command } from '#web-app/connection.ts'

import type { ChatDecision } from './chat-questions.ts'

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
  let content = (
    <AskPanel
      card={card}
      ask={ask}
      command={command}
      notify={notify}
    />
  )

  if (decision.review) {
    content = (
      <ReviewReadiness
        request={decision.review}
        command={command}
        notify={notify}
      />
    )
  }

  return (
    <div className="chat-decision" contentEditable={ask.answered ? false : undefined}>
      {decision.blocker && <strong className="eyebrow">Blocker</strong>}
      {card.id === HYDRA_CARD ? <span className="eyebrow">Hydra question</span> : <TaskReference id={decision.relatedTask?.id ?? card.id} />}
      {content}
    </div>
  )
}
