import { TITAN_CARD } from '#titan/identity.ts'
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
    <div className="chat-decision grid gap-2 [&_.ask]:m-0 [&_.decided]:text-muted [&_.decided]:text-meta [&_.decided>summary]:text-[length:inherit] [&_blockquote]:m-0 [&_blockquote]:pl-2.5 [&_blockquote]:border-l-2 [&_blockquote]:border-line">
      {decision.blocker && <strong className="eyebrow">Blocker</strong>}
      {card.id === TITAN_CARD ? <span className="eyebrow">Titan question</span> : <TaskReference id={decision.relatedTask?.id ?? card.id} />}
      {content}
    </div>
  )
}
