import { useState } from 'react'
import type { Ask, Card } from '../../../src/core/model.ts'
import { askWording } from '../../../src/core/asks.ts'
import { Button, Textarea } from '../components/ui/controls.tsx'
import { CollapsibleText, Disclosure } from '../components/ui/disclosure.tsx'
import type { Command } from './connection.ts'

const RECEIPT: Record<string, string> = {
  delivered: 'Answer sent to the worker.',
  failed: 'Answer not sent. Send it again.',
}

// A question waiting for the owner: the question leads, choices and a typed answer, evidence folded away.
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
      // Hydra's own question is answered once recorded; a worker's once its session has the reply.
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
      <p className="ask-headline">{question}</p>
      {context && <CollapsibleText text={context} />}
      {question !== ask.question && <p className="decision-from">The worker asked: {ask.question}</p>}
      {!!options.length && (
        <div className="ask-options" role="group" aria-label="Choices">
          {options.map((
            option,
            i,
          ) => (
            <Button
              key={option.label}
              className="ask-option"
              aria-pressed={pick === i + 1}
              onClick={() => setPick(pick === i + 1 ? undefined : i + 1)}
            >
              <span className="ask-label">
                {option.label}
                {ask.recommended === i + 1 && <span className="decision-recommended">Recommended</span>}
              </span>
              {option.description && <span className="ask-description">{option.description}</span>}
            </Button>
          ))}
        </div>
      )}
      <Textarea
        aria-label="Your answer"
        placeholder={options.length ? 'Add a note, or answer in your own words' : 'Your answer'}
        rows={2}
        value={text}
        onChange={e => setText(e.target.value)}
      />
      {ask.details && (
        <Disclosure className="decision-details" title="Details">
          <CollapsibleText text={ask.details} />
        </Disclosure>
      )}
      <div className="pending-decision-actions">
        <span className="muted small">{ask.escalated ? 'Hydra passed this on' : 'Hydra asks'}{ask.escalated?.reason ? `: ${ask.escalated.reason}` : ''}</span>
        <Button variant="surface" disabled={busy || (!pick && !text.trim())} onClick={() => void send()}>Send answer</Button>
      </div>
    </article>
  )
}
