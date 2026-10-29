import { memoryReview } from '#memory/review.ts'
import { HYDRA_CARD } from './identity.ts'
import { hydraEvent, pnyxRunsHydra } from './hydra.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { boardReview, MINUTE_MS } from './review.ts'
import { seenAt } from '#workers/presence.ts'
import { taskMention } from './mentions.ts'
import { hydraConfig } from './config.ts'
import { readSettings } from '#settings/store.ts'
import { DEFAULT_REVIEW_MINUTES } from '#settings/settings.ts'

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

  return {
    review,
    flags,
    previousFlags,
    empty: !review.live && !flags.length && !previousFlags.size,
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

  const check = () => {
    try {
      const state = shared()
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

      const memory = memoryReview({
        state,
        now: new Date(time).toISOString(),
      })

      if (timedReview({
        memory,
        state,
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
          const cadence = readSettings().settings.reviewMinutes * MINUTE_MS
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

          for (const flag of review.flags.filter(flag => flag.kind === 'question reminder')) {
            const card = current.cards[flag.task]
            const reminder = hydraEvent({
              state: writer.state,
              meta: {
                at: new Date(time).toISOString(),
                actor: 'pnyx',
              },
              cardId: card.id,
              change: {
                type: 'hydra.message',
                data: {
                  action: 'send',
                  hydra: hydraConfig({ state: current }).hydra.id,
                  task: card.id,
                  text: `Reminder: ${taskMention({
                    id: card.id,
                    title: card.title,
                  })} still needs your answer. ${flag.detail}`,
                },
              },
            })

            if ('event' in reminder) {
              writer.append({ event: reminder.event })
            }
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
                reminders: review.reminders,
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
