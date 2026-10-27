import { memoryReview } from './memory.ts'
import { HYDRA_CARD, hydraEvent, pnyxRunsHydra } from '../core/hydra.ts'
import { INTERRUPTED } from '../core/tasks.ts'
import type { HydraState } from '../app/model.ts'
import { withWriter } from '../app/writer.ts'
import { loadHydra } from '../app/store.ts'
import { boardReview, MINUTE_MS } from './board.ts'
import { seenAt } from '../integrations/presence/check.ts'

export const REVIEW_MS = 30 * MINUTE_MS
const REVIEW_POLL_MS = 15_000

function schedule({
  run,
  ms,
}: {
  run(): void
  ms: number
}): () => void {
  const timer = setInterval(
    run,
    ms,
  ).unref()

  return () => clearInterval(timer)
}

function running({ state }: { state: HydraState }): boolean {
  const card = state.cards[HYDRA_CARD]
  const activity = card?.sessionActivity ?? card?.activity

  return activity === 'working' || activity === 'interrupted'
    || Boolean(card?.attention.some(item => item.key === INTERRUPTED))
}

export function startReviewTimer({
  hydraId,
  wake,
  now = Date.now,
  interval = schedule,
  busy = () => false,
}: {
  hydraId: string
  wake(): void
  now?(): number
  interval?({
    run,
    ms,
  }: {
    run(): void
    ms: number
  }): () => void
  busy?(): boolean
}) {
  const started = now()

  const check = () => {
    try {
      const state = loadHydra({ hydraId }).state
      const minutes = state.config?.reviewMinutes ?? REVIEW_MS / MINUTE_MS
      const last = state.hydraReview?.at
      const due = (last ? Date.parse(last) : started) + minutes * MINUTE_MS
      const time = now()

      if (!minutes || time < due || !pnyxRunsHydra({ state }) || running({ state }) || busy()) {
        return
      }

      const memory = memoryReview({
        state,
        now: new Date(time).toISOString(),
      })
      const recorded = withWriter({
        hydraId,
        fn: ({ writer }) => {
          const current = writer.state
          const previous = current.hydraReview?.at
          const cadence = (current.config?.reviewMinutes ?? REVIEW_MS / MINUTE_MS) * MINUTE_MS
          const deadline = (previous ? Date.parse(previous) : started) + cadence

          const unavailable = running({ state: current }) || !pnyxRunsHydra({ state: current })

          if (!cadence || time < deadline || unavailable) {
            return false
          }

          const review = boardReview({
            memory,
            state: current,
            now: time,
            workerSeenAt: Object.fromEntries(Object.values(current.sessions ?? {}).map(session => [
              session.id,
              seenAt({ session }),
            ])),
          })

          if (!review.live) {
            return false
          }

          const decision = hydraEvent({
            state: current,
            meta: {
              at: new Date(time).toISOString(),
              actor: 'pnyx',
            },
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.review',
              data: {
                block: review.block,
                reminders: review.reminders,
              },
            },
          })

          if (!('event' in decision)) {
            return false
          }

          writer.append({ event: decision.event })

          return true
        },
      })

      if (recorded) {
        wake()
      }
    } catch (error) {
      console.error(`pnyx-axi review: ${(error as Error).message}`)
    }
  }

  const cancel = interval({
    run: check,
    ms: REVIEW_POLL_MS,
  })

  return {
    check,
    close: cancel,
  }
}
