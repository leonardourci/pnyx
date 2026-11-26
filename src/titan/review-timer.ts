import { log } from '#app/diagnostics.ts'
import { memoryReview } from '#memory/review.ts'
import { TITAN_CARD } from './identity.ts'
import { hydraEvent, othrysRunsTitan } from './titan.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import type { TitanState } from '#app/model.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { boardReview, MINUTE_MS } from './review.ts'
import { seenAt } from '#workers/presence.ts'
import { fireReminders } from '#tasks/fire-reminders.ts'
import { readSettings } from '#settings/store.ts'
import { background } from '#app/background.ts'

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

function running({ state }: { state: TitanState }): boolean {
  const card = state.cards[TITAN_CARD]
  const activity = card?.sessionActivity ?? card?.activity

  return activity === 'working' || activity === 'interrupted'
    || Boolean(card?.attention.some(item => item.key === INTERRUPTED))
}

function timedReview({
  memory,
  state,
  now,
}: {
  memory: string[]
  state: TitanState
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
    .filter(flag => flag.kind !== 'memory behind')
    .map(flag => JSON.stringify([
      flag.kind,
      flag.task,
      flag.reminder ?? flag.detail,
    ]))
  const previousFlags = new Set(state.hydraReview?.flags ?? [])
  // An idle Titan whose flags are unchanged, such as a stale `left-off`, has nothing to record.
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
  titanId,
  wake,
  now = Date.now,
  interval = schedule,
  busy = () => false,
  state: shared = () => loadTitan({ titanId }).state,
}: {
  titanId: string
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
  // The server passes the Titan it already holds; other callers read it from disk.
  state?(): TitanState
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
        await fireReminders({
          titanId,
          at: new Date(now()).toISOString(),
          state,
        })
      } catch (error) {
        log({
          level: 'error',
          operation: 'reminders',
          titanId,
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

      if (!minutes || time < due || !othrysRunsTitan({ state }) || running({ state }) || busy()) {
        return
      }

      const reviewed = await memoryReview({
        titanId,
        now: new Date(time).toISOString(),
      })

      const memory = reviewed.lines

      // The memory read waited on git; the review looks at the Titan as it is now, as the write below does.
      if (timedReview({
        memory,
        state: shared(),
        now: time,
      }).empty) {
        emptyAt = time

        return
      }

      const recorded = await withWriter({
        titanId,
        fn: ({ writer }) => {
          const current = writer.state
          const previous = current.hydraReview?.at
          const cadence = readSettings().settings.reviewMinutes * MINUTE_MS
          const deadline = Math.max(
            previous ? Date.parse(previous) : started,
            emptyAt,
          ) + cadence

          const unavailable = running({ state: current }) || !othrysRunsTitan({ state: current })

          if (!cadence || time < deadline || unavailable || busy()) {
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
              actor: 'othrys',
            },
            cardId: TITAN_CARD,
            change: {
              type: 'titan.review',
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
        titanId,
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
