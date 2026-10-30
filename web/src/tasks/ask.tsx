import { ChoiceOption } from '#web-shared/ui/choice-option.tsx'
import { useState } from 'react'
import type { Ask, Card } from '#tasks/model.ts'
import { answerDelivery, askWording } from '#tasks/questions.ts'
import { Button, Textarea } from '#web-shared/ui/controls.tsx'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { RichText } from '#web-shared/ui/rich-text.tsx'
import type { Command } from '#web-app/connection.ts'

const RECEIPT: Record<string, string> = {
  delivered: 'Answer sent to the worker.',
  failed: 'Answer saved. Delivery failed; send it again.',
}

export function AskPanel({
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
  const delivery = answerDelivery({
    card,
    question: ask.id,
  })
  const saved = delivery?.decision
  const savedChoice = ask.options?.findIndex(option => option.label === saved?.choice)
  const savedPick = savedChoice !== undefined && savedChoice >= 0 ? savedChoice + 1 : undefined
  let savedText = ''

  if (saved && saved.answer !== saved.choice) {
    savedText = saved.answer
  }

  const [
    draft,
    setDraft,
  ] = useState<{
    pick?: number
    text: string
  }>()
  const pick = draft ? draft.pick : savedPick
  const text = draft ? draft.text : savedText
  const [
    busy,
    setBusy,
  ] = useState(false)
  const {
    question,
    context,
  } = askWording({ ask })
  const options = ask.options ?? []
  const pending = delivery?.state === 'queued' || delivery?.state === 'delivery_unknown'
  const failed = delivery?.state === 'failed'
  const sendLabel = failed ? 'Send answer again' : 'Send answer'

  const send = async () => {
    setBusy(true)

    try {
      const receipt = await command({
        name: 'task',
        args: [
          'answer',
          card.id,
          ask.id,
          ...(pick ? [
            '--choice',
            String(pick),
          ] : []),
          ...(text.trim() ? [
            '--text',
            text,
          ] : []),
          '--event-id',
          crypto.randomUUID(),
        ],
      })
      const notice = receipt.answered ? 'Answer sent to Hydra.' : RECEIPT[String(receipt.state)]
      notify({ text: notice ?? 'The answer may not have arrived. Check the session before answering again.' })
    } catch (error) {
      notify({ text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  if (pending) {
    return (
      <article className="ask ask-structured" aria-label="Answered question">
        <CollapsibleText className="ask-headline" text={question} />
        <p className="muted small">Answer saved. Waiting to reach the worker.</p>
        {saved && <CollapsibleText text={saved.answer} />}
      </article>
    )
  }

  return (
    <article className="ask ask-structured" aria-label="Question for you">
      <div className="ask-headline"><RichText text={question} /></div>
      {failed && <p className="muted small">Answer saved. Delivery failed; send it again below.</p>}
      {/* The whole question shows at once: context and evidence are what the owner decides on. */}
      {context && <div className="ask-context"><RichText text={context} /></div>}
      {ask.details && <div className="ask-details"><RichText text={ask.details} /></div>}
      {question !== ask.question && <div className="decision-from">The worker asked:<CollapsibleText text={ask.question} /></div>}
      {!!options.length && (
        <div className="ask-options" role="group" aria-label="Choices">
          {options.map((
            option,
            i,
          ) => (
            <ChoiceOption
              key={option.label}
              label={option.label}
              description={option.description}
              selected={pick === i + 1}
              choose={() => setDraft({
                pick: pick === i + 1 ? undefined : i + 1,
                text,
              })}
            >
              {ask.recommended === i + 1 && <span className="decision-recommended">Recommended</span>}
            </ChoiceOption>
          ))}
        </div>
      )}
      <Textarea
        contentEditable={false}
        aria-label="Your answer"
        placeholder={options.length ? 'Add a note, or answer in your own words' : 'Your answer'}
        rows={2}
        value={text}
        onChange={e => setDraft({
          pick,
          text: e.target.value,
        })}
      />
      <div className="pending-decision-actions">
        <div className="muted small">{ask.escalated ? 'Hydra passed this on' : 'Hydra asks'}{ask.escalated?.reason && <CollapsibleText text={ask.escalated.reason} />}</div>
        <Button
          contentEditable={false}
          variant="surface"
          disabled={busy || (!pick && !text.trim())}
          onClick={() => void send()}
        >{sendLabel}
        </Button>
      </div>
    </article>
  )
}
