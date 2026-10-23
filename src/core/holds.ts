import { findCard, type Meta } from './decide.ts'
import { hydraEvent, HYDRA_CARD } from './hydra.ts'
import { HydraError, HYDRA_ACTOR, ownerActor, type Card, type HydraState } from './model.ts'

export function requireUnheld({ card }: { card: Card }): void {
  if (card.hold) {
    throw new HydraError({
      message: `task ${card.id} is held for discussion: ${card.hold.reason}`,
      code: 'TASK_HELD',
      help: ['Discuss with the owner, then ask a go question or release with their newer message'],
    })
  }
}

export function decideHold({
  state,
  ref,
  message,
  release,
  meta,
}: {
  state: HydraState
  ref: string
  message?: string
  release: boolean
  meta: Meta
}) {
  const card = findCard({
    state,
    ref,
  })

  if (card.id === HYDRA_CARD || card.automaticTask) {
    throw new HydraError({
      message: 'hold a task card',
      code: 'VALIDATION_ERROR',
    })
  }

  if (!ownerActor({ actor: meta.actor }) && meta.actor !== HYDRA_ACTOR) {
    throw new HydraError({
      message: 'only Hydra or the owner manages discussion holds',
      code: 'OWNER_ONLY',
    })
  }

  const reason = meta.reason?.trim()

  if (!reason) {
    throw new HydraError({
      message: 'pass --reason for the discussion hold or release',
      code: 'VALIDATION_ERROR',
    })
  }

  if (!release) {
    return hydraEvent({
      state,
      meta,
      cardId: card.id,
      change: {
        type: 'task.held',
        data: { reason },
      },
    })
  }

  const source = state.hydraMessages?.find(entry => entry.id === message)
  const ownerMessage = source?.action === 'send' && ownerActor({ actor: source.actor })
  const newer = source && card.hold && Date.parse(source.at) > Date.parse(card.hold.at)

  if (!card.hold || !ownerMessage || !newer) {
    throw new HydraError({
      message: '--from-message must name the owner’s own message sent after the current hold',
      code: 'VALIDATION_ERROR',
    })
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.released',
      data: {
        hold: card.hold.id,
        message: {
          id: source.id,
          text: source.text,
          at: source.at,
        },
      },
    },
  })
}
