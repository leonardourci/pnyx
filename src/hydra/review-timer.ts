import { log } from '#app/diagnostics.ts'
import { memoryReview } from '#memory/review.ts'
import { HYDRA_CARD } from './identity.ts'
import { hydraEvent, pnyxRunsHydra } from './hydra.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { boardReview, MINUTE_MS } from './review.ts'
import { seenAt } from '#workers/presence.ts'
import { fireReminders } from '#tasks/fire-reminders.ts'
import { readSettings } from '#settings/store.ts'
import { DEFAULT_REVIEW_MINUTES } from '#settings/settings.ts'
import { background } from '#app/background.ts'

export const REVIEW_MS = DEFAULT_REVIEW_MINUTES * MINUTE_MS
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

// Worked out the same way before taking the lock and under it.
function timedReview({
  memory,
  state,
  now,
}: {
  memory: string[]
  state: HydraState
  now: number
}) {
  const review = boardReview({
    memory,
    state,
    now,
    workerSeenAt: Object.fromEntries(Object.values(state.sessions ?? {}).map(session => [
      session.id,
      seenAt({ session }),
    ])),
  })
  const flags = review.flags
    .filter(flag => flag.kind !== 'memory behind' && flag.kind !== 'question reminder')
    .map(flag => JSON.stringify([
      flag.kind,
      flag.task,
      flag.detail,
    ]))
  const previousFlags = new Set(state.hydraReview?.flags ?? [])
  // An idle Hydra whose flags are unchanged, such as a stale `left-off`, has nothing to record.
  const unchanged = flags.length === previousFlags.size
    && flags.every(flag => previousFlags.has(flag))

  return {
    review,
    flags,
    previousFlags,
    empty: !review.live && unchanged,
  }
}

export function startReviewTimer({
  hydraId,
  wake,
  now = Date.now,
  interval = schedule,
  busy = () => false,
  state: shared = () => loadHydra({ hydraId }).state,
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
  // The server passes the Hydra it already holds; other callers read it from disk.
  state?(): HydraState
}) {
  const started = now()
  // An empty review records nothing, so the next one counts its period from here.
  let emptyAt = 0
  // Memory review reads git; the server's loop keeps calling while one read is out.
  let reviewing = false

  const check = async () => {
    if (reviewing) {
      return
    }

    reviewing = true

    try {
      const state = shared()

      try {
        fireReminders({
          hydraId,
          at: new Date(now()).toISOString(),
          state,
        })
      } catch (error) {
        log({
          level: 'error',
          operation: 'reminders',
          hydraId,
          error,
        })
      }

      const minutes = readSettings().settings.reviewMinutes
      const last = state.hydraReview?.at
      const due = Math.max(
        last ? Date.parse(last) : started,
        emptyAt,
      ) + minutes * MINUTE_MS
      const time = now()

      if (!minutes || time < due || !pnyxRunsHydra({ state }) || running({ state }) || busy()) {
        return
      }

      const memory = await memoryReview({
        state,
        now: new Date(time).toISOString(),
      })

      // The memory read waited on git; the review looks at the Hydra as it is now, as the write below does.
      if (timedReview({
        memory,
        state: shared(),
        now: time,
      }).empty) {
        emptyAt = time

        return
      }

      const recorded = withWriter({
        hydraId,
        fn: ({ writer }) => {
          const current = writer.state
          const previous = current.hydraReview?.at
          const cadence = minutes * MINUTE_MS
          const deadline = (previous ? Date.parse(previous) : started) + cadence

          const unavailable = running({ state: current }) || !pnyxRunsHydra({ state: current })

          if (!cadence || time < deadline || unavailable) {
            return false
          }

          const {
            review,
            flags,
            previousFlags,
            empty,
          } = timedReview({
            memory,
            state: current,
            now: time,
          })
          const shouldWake = flags.some(flag => !previousFlags.has(flag))

          if (empty) {
            return false
          }

          const decision = hydraEvent({
            state: writer.state,
            meta: {
              at: new Date(time).toISOString(),
              actor: 'pnyx',
            },
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.review',
              data: {
                block: review.block,
                reminders: [],
                flags,
                wake: shouldWake,
              },
            },
          })

          if (!('event' in decision)) {
            return false
          }

          writer.append({ event: decision.event })

          return shouldWake
        },
      })

      if (recorded) {
        wake()
      }
    } catch (error) {
      log({
        level: 'error',
        operation: 'review',
        hydraId,
        error,
      })
    } finally {
      reviewing = false
    }
  }

  const cancel = interval({
    run: () => background({
      name: 'review',
      run: check,
    }),
    ms: REVIEW_POLL_MS,
  })

  return {
    check,
    close: cancel,
  }
}
