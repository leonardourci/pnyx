import { ChoiceOption } from '#web-shared/ui/choice-option.tsx'
import { useState } from 'react'
import type { Ask, Card } from '#tasks/model.ts'
import { askWording } from '#tasks/questions.ts'
import { Button, Textarea } from '#web-shared/ui/controls.tsx'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { Markdown } from '#web-hydra/markdown.tsx'
import type { Command } from '#web-app/connection.ts'

const RECEIPT: Record<string, string> = {
  delivered: 'Answer sent to the worker.',
  failed: 'Answer not sent. Send it again.',
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
  const [
    pick,
    setPick,
  ] = useState<number>()
  const [
    text,
    setText,
  ] = useState('')
  const [
    busy,
    setBusy,
  ] = useState(false)
  const {
    question,
    context,
  } = askWording({ ask })
  const options = ask.options ?? []

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

  return (
    <article className="ask ask-structured" aria-label="Question for you">
      <div className="ask-headline"><Markdown text={question} /></div>
      {/* The whole question shows at once: context and evidence are what the owner decides on. */}
      {context && <div className="ask-context"><Markdown text={context} /></div>}
      {ask.details && <div className="ask-details"><Markdown text={ask.details} /></div>}
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
              choose={() => setPick(pick === i + 1 ? undefined : i + 1)}
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
        onChange={e => setText(e.target.value)}
      />
      <div className="pending-decision-actions">
        <div className="muted small">{ask.escalated ? 'Hydra passed this on' : 'Hydra asks'}{ask.escalated?.reason && <CollapsibleText text={ask.escalated.reason} />}</div>
        <Button
          contentEditable={false}
          variant="surface"
          disabled={busy || (!pick && !text.trim())}
          onClick={() => void send()}
        >Send answer
        </Button>
      </div>
    </article>
  )
}
