import type { Ask, Card } from '#tasks/model.ts'
import { askWording } from '#tasks/ask-state.ts'
import { Disclosure, CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { clock } from '#web-hydra/chat.ts'
import type { Command } from '#web-app/connection.ts'

export const recordedAnswers = ({ card }: { card: Card }) =>
  (card.asks ?? []).filter(ask => ask.answered && ask.fromMessage && !ask.closed)

export function AnsweredQuestions({
  card,
  command,
  notify,
}: {
  card: Card
  command: Command
  notify({ text }: { text: string }): void
}) {
  return recordedAnswers({ card }).map(ask => (
    <AnsweredQuestion
      key={ask.id}
      card={card}
      ask={ask}
      command={command}
      notify={notify}
    />
  ))
}

export function AnsweredQuestion({
  card,
  ask,
  command,
  notify,
}: {
  card: Card
  ask: Ask
  command: Command
  notify({ text }: { text: string }): void
}) {
  const decidedAt = ask.answeredAt ?? ask.fromMessage?.at
  const title = (
    <>Decided {decidedAt && clock({ at: decidedAt })}
      {ask.fromMessage && ' from your message'} · {askWording({ ask }).question}
    </>
  )

  if (!ask.fromMessage) {
    return <p className="decided">{title}</p>
  }

  const recorded = ask.mergeHold && ask.choice === 'Merge'
    ? 'Hydra lifted Hold using your answer' : 'Recorded as your answer'

  return (
    <div className="decided">
      <Disclosure title={<>{recorded} to ‘{askWording({ ask }).question}’</>}>
        <blockquote><CollapsibleText text={ask.fromMessage.text} /></blockquote>
      </Disclosure>
      <Button
        onClick={async () => {
          try {
            await command({
              name: 'task',
              args: [
                'reopen-question',
                card.id,
                ask.id,
                '--answer',
                ask.answered ?? '',
              ],
            })
            notify({ text: ask.mergeHold ? 'Hold restored.' : 'Question reopened.' })
          } catch (error) {
            notify({ text: String(error) })
          }
        }}
      >Undo answer
      </Button>
    </div>
  )
}
