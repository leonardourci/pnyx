import { useState } from 'react'
import { Button } from '#web-shared/ui/controls.tsx'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import type { Command } from '#web-app/connection.ts'
import { reviewState, type ReviewRequest } from './review-requests.ts'
import { QuestionTiming } from './question-timing.tsx'

export function ReviewReadiness({
  request,
  command,
  notify,
}: {
  request: ReviewRequest
  command: Command
  notify({ text }: { text: string }): void
}) {
  const {
    card,
    ask,
    link,
  } = request
  const [
    busy,
    setBusy,
  ] = useState(false)
  const approved = ask.answered && ask.choice === 'Merge'
  const inFlight = !!link.mergeAttempt
  const state = reviewState({ request })

  const choose = async ({ choice }: { choice: 'Merge' | 'Hold' }) => {
    if (busy) {
      return
    }

    setBusy(true)

    try {
      await command({
        name: 'task',
        args: [
          'answer',
          card.id,
          ask.id,
          '--choice',
          choice,
          '--event-id',
          crypto.randomUUID(),
        ],
      })
      notify({ text: choice === 'Merge' ? 'Merge approved. Hydra will run the required checks.' : 'Review put on hold.' })
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ask ask-structured" aria-label="Pull request review">
      <strong className="eyebrow">{state}</strong>
      <CollapsibleText text={ask.context ?? link.title ?? link.url} />
      <p className="muted small">Checks: {link.checks ?? 'not read yet'}. Hydra merges after the required checks pass.</p>
      <div className="pending-decision-actions">
        <a
          className="button surface"
          href={link.url}
          target="_blank"
          rel="noreferrer"
        >Review
        </a>
        <Button
          disabled={busy || !!approved || inFlight || !!ask.deferredUntil}
          onClick={async () => {
            await choose({ choice: 'Merge' })
          }}
        >Merge
        </Button>
        <Button
          disabled={busy || !!ask.answered || inFlight || !!ask.deferredUntil}
          onClick={async () => {
            await choose({ choice: 'Hold' })
          }}
        >Hold
        </Button>
      </div>
      {!ask.answered && (
        <QuestionTiming
          card={card}
          ask={ask}
          command={command}
          notify={notify}
          disabled={busy || inFlight}
        />
      )}
    </section>
  )
}

export function ReviewSummary({
  request,
  open,
}: {
  request: ReviewRequest
  open(): void
}) {
  return (
    <div className="card-question" aria-label="Pull request review summary">
      <strong className="eyebrow">{reviewState({ request })}</strong>
      <CollapsibleText text={request.link.title ?? request.link.url} />
      <Button variant="primary" onClick={open}>Review</Button>
    </div>
  )
}
