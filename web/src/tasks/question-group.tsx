import { useRef, useState } from 'react'
import type { QuestionGroup } from '#tasks/question-groups.ts'
import { decisionKey } from '#tasks/question-groups.ts'
import type { Command } from '#web-app/connection.ts'
import { sessionViewKey, useSessionView } from '#web-app/session-view.ts'
import { Button } from '#web-shared/ui/controls.tsx'

interface GroupAttempt {
  id: string
  task: string
  title: string
  choice: string
  questions: string[]
}

export function useGroupAnswers({
  hydraId,
  command,
  notify,
}: {
  hydraId: string
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [
    pending,
    setPending,
  ] = useSessionView<GroupAttempt[]>({
    key: sessionViewKey({
      scope: 'question-groups',
      id: hydraId,
      field: 'pending',
    }),
    initial: [],
  })
  const [
    busy,
    setBusy,
  ] = useState<string | null>(null)
  const sending = useRef(false)

  const dismiss = ({ id }: { id: string }) => {
    setPending(pending.filter(attempt => attempt.id !== id))
  }

  const send = async ({ attempt }: { attempt: GroupAttempt }) => {
    if (sending.current) {
      return
    }

    sending.current = true
    setBusy(attempt.id)

    const alreadySaved = pending.some(saved => saved.id === attempt.id)

    if (!alreadySaved) {
      setPending([
        ...pending,
        attempt,
      ])
    }

    try {
      const receipt = await command({
        name: 'task',
        args: [
          'answer-group',
          attempt.task,
          '--choice',
          attempt.choice,
          '--questions',
          JSON.stringify(attempt.questions),
          '--event-id',
          attempt.id,
        ],
      })
      const answers = receipt.answers as { state?: string }[]
      const unsettled = answers.some(answer => answer.state === 'queued'
        || answer.state === 'failed' || answer.state === 'delivery_unknown')

      if (!unsettled) {
        dismiss({ id: attempt.id })
      }

      notify({ text: unsettled ? 'Some answers still need delivery' : 'Group answer submitted' })
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    } finally {
      sending.current = false
      setBusy(null)
    }
  }

  const answer = async ({
    group,
    choice,
  }: {
    group: QuestionGroup
    choice: string
  }) => {
    await send({
      attempt: {
        id: crypto.randomUUID(),
        task: group.card.id,
        title: group.card.title,
        choice,
        questions: group.decisions.map(decision => decisionKey({ decision })),
      },
    })
  }

  return {
    pending,
    busy,
    answer,
    retry: send,
    dismiss,
  }
}

type GroupAnswers = ReturnType<typeof useGroupAnswers>

export function GroupAnswerRetries({ answers }: { answers: GroupAnswers }) {
  if (!answers.pending.length) {
    return null
  }

  return (
    <section className="group-answer-delivery mx-(--chat-inset) py-1.5 text-meta text-muted" aria-label="Group answer delivery">
      {answers.pending.map(attempt => (
        <div key={attempt.id} className="flex flex-wrap items-center gap-1.5">
          <span>{attempt.title} · {attempt.choice}</span>
          <Button disabled={!!answers.busy} aria-label={`Retry group answer: ${attempt.title}`} onClick={() => answers.retry({ attempt })}>
            {answers.busy === attempt.id ? 'Sending…' : 'Retry group answer'}
          </Button>
          <Button disabled={!!answers.busy} aria-label={`Dismiss group answer: ${attempt.title}`} onClick={() => answers.dismiss({ id: attempt.id })}>Dismiss</Button>
        </div>
      ))}
    </section>
  )
}

export function QuestionGroupAnswers({
  group,
  answers,
  disabled,
}: {
  group: QuestionGroup
  answers: GroupAnswers
  disabled: boolean
}) {
  if (group.decisions.length < 2 || !group.choices.length) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answer group">
      {group.choices.map(choice => (
        <Button
          key={choice}
          disabled={disabled || !!answers.busy}
          aria-label={`Answer all ${group.decisions.length}: ${choice}`}
          onClick={() => answers.answer({
            group,
            choice,
          })}
        >
          {choice} · all {group.decisions.length}
        </Button>
      ))}
    </div>
  )
}
