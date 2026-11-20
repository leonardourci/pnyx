import { statSync } from 'node:fs'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { joinMessageParts } from '#hydra/history.ts'
import { sessionEntries, threadPath } from '#hydra/transcripts-read.ts'
import { replyEchoes } from '#hydra/task-messages.ts'
import { isManagedTask } from '#tasks/select.ts'
import { steeringText } from './inbox-notice.ts'
import { cardSessionId } from './session-attachments.ts'

export interface TypedWords {
  task: string
  at: string
  text: string
}

// The owner's words typed straight into a worker's session, in its terminal or the Paseo app: the user messages of the
// task's transcript that echo no reply Pnyx queued and are none of Pnyx's own inputs (start prompts, steering notices).
// Only words written from `from` and before `to` count. A worker Pnyx runs has no terminal, so its transcript is not read.
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

    const echoes = replyEchoes({
      card: card.id,
      events: replies,
    })

    const typed = sessionEntries({
      path,
      session,
      boundaries: false,
    }).filter(entry => {
      if (entry.role !== 'user' || entry.pnyx || echoes.take({ text: entry.text })) {
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
