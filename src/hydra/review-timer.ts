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

          const flags = review.flags
            .filter(flag => flag.kind !== 'memory behind' && flag.kind !== 'question reminder')
            .map(flag => JSON.stringify([
              flag.kind,
              flag.task,
              flag.detail,
            ]))
          const previousFlags = new Set(current.hydraReview?.flags ?? [])
          const shouldWake = flags.some(flag => !previousFlags.has(flag))

          if (!review.live && !flags.length && !previousFlags.size) {
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
