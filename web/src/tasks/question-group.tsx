import { useRef, useState } from 'react'
import type { QuestionGroup } from '#tasks/question-groups.ts'
import { decisionKey } from '#tasks/question-groups.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'

export function QuestionGroupAnswers({
  group,
  command,
  notify,
  disabled,
}: {
  group: QuestionGroup
  command: Command
  notify({ text }: { text: string }): void
  disabled: boolean
}) {
  const [
    busy,
    setBusy,
  ] = useState(false)
  const attempt = useRef<{ snapshot: string; choice: string; id: string } | null>(null)

  if (group.decisions.length < 2 || !group.choices.length) {
    return null
  }

  const send = async ({ choice }: { choice: string }) => {
    if (busy) {
      return
    }

    const snapshot = JSON.stringify(group.decisions.map(decision => decisionKey({ decision })))
    const previous = attempt.current
    const id = previous?.snapshot === snapshot && previous.choice === choice
      ? previous.id : crypto.randomUUID()
    attempt.current = {
      snapshot,
      choice,
      id,
    }
    setBusy(true)

    try {
      await command({
        name: 'task',
        args: [
          'answer-group',
          group.card.id,
          '--choice',
          choice,
          '--questions',
          snapshot,
          '--event-id',
          id,
        ],
      })
      attempt.current = null
      notify({ text: 'Group answer submitted' })
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answer group">
      {group.choices.map(choice => (
        <Button
          key={choice}
          disabled={disabled || busy}
          aria-label={`Answer all ${group.decisions.length}: ${choice}`}
          onClick={async () => {
            await send({ choice })
          }}
        >
          {choice} · all {group.decisions.length}
        </Button>
      ))}
    </div>
  )
}
