import { QuestionActions, QuestionPanel } from '#web-shared/ui/question-panel.tsx'
import { useState } from 'react'
import { Button } from '#web-shared/ui/controls.tsx'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { ComposerField } from '#web-titan/composer-field.tsx'
import { hasPendingImage } from '#web-titan/draft.ts'
import type { Command } from '#web-app/connection.ts'
import { reviewState, type ReviewRequest } from './review-requests.ts'
import { QuestionTiming } from './question-timing.tsx'
import { textOption } from './ask.tsx'

const NOTICE = {
  Merge: 'Merge approved. Titan will run the required checks.',
  Hold: 'Review put on hold.',
  note: 'Note sent to Titan. The review stays open.',
}

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
  const [
    note,
    setNote,
  ] = useState('')
  const approved = ask.answered && ask.choice === 'Merge'
  const inFlight = !!link.mergeAttempt
  const state = reviewState({ request })
  const noted = !!note.trim()
  const locked = busy || inFlight || !!ask.deferredUntil || hasPendingImage({ text: note })

  // A note alone is a discussion: it reaches Titan and leaves the decision open.
  const send = async ({ choice }: { choice?: 'Merge' | 'Hold' }) => {
    if (busy) {
      return
    }

    setBusy(true)
    const args = choice ? [
      'answer',
      card.id,
      ask.id,
      '--choice',
      choice,
    ] : [
      'discuss-question',
      card.id,
      ask.id,
    ]

    if (noted) {
      args.push(textOption({ text: note }))
    }

    args.push(
      '--event-id',
      crypto.randomUUID(),
    )

    try {
      await command({
        name: 'task',
        args,
      })
      setNote(current => current === note ? '' : current)
      notify({ text: choice ? NOTICE[choice] : NOTICE.note })
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <QuestionPanel as="section" className="ask-structured" aria-label="Pull request review">
      <strong className="eyebrow">{state}</strong>
      <CollapsibleText text={ask.context ?? link.title ?? link.url} />
      <p className="muted small">Checks: {link.checks ?? 'not read yet'}. Titan merges after the required checks pass.</p>
      {!approved && (
        <ComposerField
          label="Note for Titan"
          placeholder="Add a note or a point to highlight"
          value={note}
          change={({ text }) => setNote(text)}
        />
      )}
      <QuestionActions>
        <Button
          disabled={locked || !noted || !!ask.answered}
          onClick={async () => {
            await send({})
          }}
        >Send note
        </Button>
        <Button
          disabled={locked || !!approved}
          onClick={async () => {
            await send({ choice: 'Merge' })
          }}
        >Merge
        </Button>
        <Button
          disabled={locked || !!ask.answered}
          onClick={async () => {
            await send({ choice: 'Hold' })
          }}
        >Hold
        </Button>
      </QuestionActions>
      {!ask.answered && (
        <QuestionTiming
          card={card}
          ask={ask}
          command={command}
          notify={notify}
          disabled={busy || inFlight}
        />
      )}
    </QuestionPanel>
  )
}
