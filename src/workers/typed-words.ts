import { statSync } from 'node:fs'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { joinMessageParts } from '#hydra/history.ts'
import { sessionEntries, threadPath } from '#hydra/transcripts-read.ts'
import { deliveredInputs, replyEchoes } from '#hydra/task-messages.ts'
import { isManagedTask } from '#tasks/select.ts'
import { cardSessionId } from './session-attachments.ts'

export interface TypedWords {
  task: string
  at: string
  text: string
}

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

    const entries = sessionEntries({
      path,
      session,
      boundaries: false,
    })
    const delivered = deliveredInputs({
      entries,
      echoes: replyEchoes({
        card: card.id,
        events: replies,
      }),
      agent: card.agent,
    })

    const typed = entries.filter(entry => {
      if (entry.role !== 'user' || delivered.has(entry)) {
        return false
      }

      const at = Date.parse(entry.at ?? '')

      return at >= from && at < to
    })

    return joinMessageParts({ entries: typed }).map(entry => ({
      task: card.id,
      at: entry.at!,
      text: entry.text,
    }))
  })
}
