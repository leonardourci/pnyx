import { ChoiceOption } from '#web-shared/ui/choice-option.tsx'
import { useState } from 'react'
import type { Ask, Card } from '#tasks/model.ts'
import { answerDelivery, askWording } from '#tasks/ask-state.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { ComposerField } from '#web-hydra/composer-field.tsx'
import { hasPendingImage } from '#web-hydra/draft.ts'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { RichText } from '#web-shared/ui/rich-text.tsx'
import type { Command } from '#web-app/connection.ts'
import { QuestionTiming } from './question-timing.tsx'

// The = form keeps a note that starts with a dash from reading as an option.
export const textOption = ({ text }: { text: string }) => `--text=${text}`

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
  const imagesLoading = hasPendingImage({ text })
  const sendLabel = failed ? 'Send answer again' : 'Send answer'

  const send = async ({ discuss = false }: { discuss?: boolean } = {}) => {
    setBusy(true)

    try {
      const args = [
        discuss ? 'discuss-question' : 'answer',
        card.id,
        ask.id,
      ]

      if (!discuss && pick) {
        args.push(
          '--choice',
          String(pick),
        )
      }

      if (text.trim()) {
        args.push(textOption({ text }))
      }

      args.push(
        '--event-id',
        crypto.randomUUID(),
      )
      const receipt = await command({
        name: 'task',
        args,
      })
      const clarification = discuss || !!receipt.clarification

      if (clarification) {
        notify({ text: 'Follow-up sent to Hydra. The question stays open.' })
        setDraft(current => {
          if (current && (current.text !== text || current.pick !== pick)) {
            return current
          }

          return { text: '' }
        })
      } else {
        const notice = receipt.answered ? 'Answer sent to Hydra.' : RECEIPT[String(receipt.state)]
        notify({ text: notice ?? 'The answer may not have arrived. Check the session before answering again.' })
      }
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
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

  const deferred = !!ask.deferredUntil
  const label = deferred ? 'Deferred question' : 'Question for you'

  return (
    <article className="ask ask-structured" aria-label={label}>
      <div className="ask-headline"><RichText text={question} /></div>
      {failed && <p className="muted small">Answer saved. Delivery failed; send it again below.</p>}
      {context && <div className="ask-context"><RichText text={context} /></div>}
      {ask.details && <div className="ask-details"><RichText text={ask.details} /></div>}
      {question !== ask.question && <div className="decision-from">The worker asked:<CollapsibleText text={ask.question} /></div>}
      <div className="ask-choices" hidden={deferred}>
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
        <ComposerField
          label="Your answer"
          placeholder={options.length ? 'Add a note, or answer in your own words' : 'Your answer'}
          value={text}
          change={({ text }) => setDraft({
            pick,
            text,
          })}
        />
        <div className="pending-decision-actions">
          <div className="muted small">{ask.escalated ? 'Hydra passed this on' : 'Hydra asks'}{ask.escalated?.reason && <CollapsibleText text={ask.escalated.reason} />}</div>
          <Button
            disabled={busy || imagesLoading || !text.trim()}
            onClick={async () => {
              await send({ discuss: true })
            }}
          >Ask a follow-up
          </Button>
          <Button
            contentEditable={false}
            variant="surface"
            disabled={busy || imagesLoading || (!pick && !text.trim())}
            onClick={async () => {
              await send()
            }}
          >{sendLabel}
          </Button>
        </div>
      </div>
      <QuestionTiming
        card={card}
        ask={ask}
        command={command}
        notify={notify}
        disabled={busy}
      />
    </article>
  )
}
