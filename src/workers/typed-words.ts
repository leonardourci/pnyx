import { statSync } from 'node:fs'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { joinMessageParts } from '#hydra/history.ts'
import { sessionEntries, splitEntry, threadPath } from '#hydra/transcripts-read.ts'
import { isManagedTask } from '#tasks/select.ts'
import { steeringText } from './inbox-notice.ts'
import { cardSessionId } from './session-attachments.ts'

export interface TypedWords {
  task: string
  at: string
  text: string
}

// The owner's words typed straight into a worker's session, in its terminal or the Paseo app:
// the user messages of the task's transcript that echo no reply Pnyx queued for it and are none
// of Pnyx's own inputs: start prompts and steering notices. Only words written from `from` and before `to` count. A worker Pnyx runs
// has no terminal to type into, so its transcript is not read.
export function typedWords({
  state,
  replies,
  from,
  to,
}: {
  state: HydraState
  replies: HydraEvent[]
  from: number
  to: number
}): TypedWords[] {
  return Object.values(state.cards).flatMap(card => {
    const path = threadPath({ card })
    const session = cardSessionId({ card })
    const pnyxRuns = card.agent?.host === 'pnyx'

    if (isManagedTask({ card }) || pnyxRuns || !path || !session) {
      return []
    }

    const written = statSync(
      path,
      { throwIfNoEntry: false },
    )?.mtimeMs

    if (written === undefined || written < from) {
      return []
    }

    const sent = new Map<string, number>()

    for (const reply of replies) {
      if (reply.type !== 'card.replied' || reply.cardId !== card.id) {
        continue
      }

      const parts = splitEntry({
        entry: {
          id: reply.data.reply,
          role: 'user',
          kind: 'message',
          text: [
            reply.data.text,
            reply.data.context,
          ].filter(Boolean).join('\n\n'),
        },
      })

      for (const part of parts) {
        sent.set(
          part.text,
          (sent.get(part.text) ?? 0) + 1,
        )
      }
    }

    const typed = sessionEntries({
      path,
      session,
      boundaries: false,
    }).filter(entry => {
      if (entry.role !== 'user' || entry.pnyx) {
        return false
      }

      const echoes = sent.get(entry.text) ?? 0

      if (echoes) {
        sent.set(
          entry.text,
          echoes - 1,
        )

        return false
      }

      const at = Date.parse(entry.at ?? '')

      return at >= from && at < to
    })

    return joinMessageParts({ entries: typed })
      .filter(({ text }) => !steeringText({ text }))
      .map(entry => ({
        task: card.id,
        at: entry.at!,
        text: entry.text,
      }))
  })
}
