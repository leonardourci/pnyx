import { randomUUID } from 'node:crypto'
import { HYDRA_CARD } from '../hydra/identity.ts'
import type { HydraState } from '../app/model.ts'
import { EVENT_VERSION } from '../store/events.ts'
import type { Card } from '../tasks/model.ts'
import type { SteeringMessage, SteeringRecovery } from './model.ts'
import { liveTask } from '../tasks/select.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { loadHydra } from '../app/store.ts'
import { withWriter, type Writer } from '../app/writer.ts'
import type { NotificationResult } from './inbox-notice.ts'
import { pendingSteering, sameClaim, steeringClaim } from './steering.ts'
import { notifySteering } from './inbox-delivery.ts'

export const STEERING_GRACE_MS = 90_000
export const STEERING_RING_LIMIT = 3
export const STEERING_DEFERRAL_LIMIT = 2

function oldestUnread({ card }: { card: Card }): SteeringMessage | undefined {
  const firstmate = card.mirror || card.sourceRefs.some(source => source.adapter === 'firstmate')

  if (!liveTask({ card }) || card.id === HYDRA_CARD || firstmate) {
    return undefined
  }

  return pendingSteering({ card })[0]
}

export function steeringToFollow({ state }: { state: HydraState }): boolean {
  return Object.values(state.cards).some(card => {
    const message = oldestUnread({ card })

    return message && !message.recovery?.some(attempt => attempt.result === 'exhausted')
  })
}

function recordRecovery({
  writer,
  card,
  message,
  recovery,
}: {
  writer: Writer
  card: string
  message: string
  recovery: SteeringRecovery
}): void {
  writer.append({
    event: {
      v: EVENT_VERSION,
      id: randomUUID(),
      seq: writer.state.seq + 1,
      cardId: card,
      at: recovery.at,
      actor: 'pnyx',
      type: 'task.steering.recovery',
      data: {
        message,
        recovery,
      },
    },
  })
}

export async function followUpSteering({
  hydraId,
  now = Date.now(),
  notify = notifySteering,
}: {
  hydraId: string
  now?: number
  notify?: typeof notifySteering
}): Promise<void> {
  const cards = Object.keys(loadHydra({ hydraId }).state.cards)

  for (const cardId of cards) {
    const reserved = withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const card = writer.state.cards[cardId]
        const message = card && oldestUnread({ card })

        if (!message) {
          return
        }

        const recovery = message.recovery ?? []

        if (recovery.some(attempt => attempt.result === 'exhausted')) {
          return
        }

        const lastAt = Math.max(
          Date.parse(message.at),
          ...recovery.map(attempt => Date.parse(attempt.at)),
        )

        if (now - lastAt < STEERING_GRACE_MS) {
          return
        }

        const deferrals = recovery.filter(attempt => attempt.result === 'deferred').length
        const rings = recovery.length - deferrals
        const exhausted = deferrals >= STEERING_DEFERRAL_LIMIT || rings >= STEERING_RING_LIMIT
        const id = `recovery:${cardId}:${message.order}:${recovery.length + 1}`
        const at = new Date(now).toISOString()
        const claim = steeringClaim({ card })

        if (exhausted) {
          recordRecovery({
            writer,
            card: cardId,
            message: message.id,
            recovery: {
              id,
              at,
              result: 'exhausted',
              detail: recovery.at(-1)?.detail ?? 'notification budget spent without a worker acknowledgement',
            },
          })

          return
        }

        recordRecovery({
          writer,
          card: cardId,
          message: message.id,
          recovery: {
            id,
            at,
            result: 'reserved',
            claim,
          },
        })

        return {
          message: message.id,
          id,
          at,
          claim,
        }
      },
    })

    if (!reserved) {
      continue
    }

    let outcome: NotificationResult

    try {
      outcome = await notify({
        hydraId,
        card: cardId,
        message: reserved.message,
        attempt: reserved.id,
        now,
      })
    } catch (error) {
      outcome = {
        result: 'unknown',
        detail: `notification outcome unknown: ${(error as Error).message}`,
      }
    }

    withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const card = writer.state.cards[cardId]
        const message = card && oldestUnread({ card })

        if (message?.id !== reserved.message) {
          return
        }

        const currentClaim = steeringClaim({ card })
        const reassigned = reserved.claim
          ? !sameClaim({
            current: currentClaim,
            claim: reserved.claim,
          }) : Boolean(currentClaim)

        if (reassigned) {
          outcome = {
            result: 'unknown',
            detail: 'worker assignment changed during notification; pending instruction retained',
          }
        }

        recordRecovery({
          writer,
          card: cardId,
          message: message.id,
          recovery: {
            id: reserved.id,
            claim: reserved.claim,
            at: reserved.at,
            result: outcome.result === 'gone' ? 'exhausted' : outcome.result,
            detail: outcome.detail,
          },
        })
      },
    })
  }
}
