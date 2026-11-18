import { useState } from 'react'
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

  if (group.decisions.length < 2 || !group.choices.length) {
    return null
  }

  const send = async ({ choice }: { choice: string }) => {
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
          JSON.stringify(group.decisions.map(decision => decisionKey({ decision }))),
          '--event-id',
          crypto.randomUUID(),
        ],
      })
      notify({ text: `Answered ${group.decisions.length} questions: ${choice}` })
    } catch (error) {
      notify({ text: (error as Error).message })
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
          onClick={() => void send({ choice })}
        >
          {choice} · all {group.decisions.length}
        </Button>
      ))}
    </div>
  )
}
