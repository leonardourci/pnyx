import { ownerActor } from '#app/actors.ts'
import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import type { Card, OwnerAsk } from './model.ts'

export function ownerAsk({
  state,
  text,
  message,
  actor,
  at,
}: {
  state: HydraState
  text: string
  message?: string
  actor: string
  at: string
}): OwnerAsk {
  if (!text.trim() || text.length > 24000) {
    throw new HydraError({
      message: 'The owner ask needs 1 to 24000 characters',
      code: 'VALIDATION_ERROR',
    })
  }

  if (message) {
    const source = state.hydraMessages?.find(entry => entry.id === message
      && ownerActor({ actor: entry.actor }))

    if (!source || !source.text.includes(text)) {
      throw new HydraError({
        message: 'Quote the saved owner message exactly',
        code: 'ASK_SOURCE_MISMATCH',
      })
    }

    return {
      text,
      at: source.at,
      actor: source.actor,
      message: source.id,
    }
  }

  if (!ownerActor({ actor })) {
    throw new HydraError({
      message: 'Only the owner can add an ask without a saved owner message',
      code: 'OWNER_ONLY',
      help: ['Pass --message <owner-message-id> and quote its words exactly'],
    })
  }

  return {
    text,
    at,
    actor,
  }
}

export function taskInstructions({ card }: { card: Card }): string {
  if (!card.ask?.length) {
    return card.brief ?? ''
  }

  const parts: string[] = []

  if (card.ask?.length) {
    parts.push(
      "Owner's ask:",
      ...card.ask.map(entry => `[${entry.at}] ${entry.text}`),
    )
  }

  if (card.brief?.trim()) {
    parts.push(
      "Hydra's build instructions:",
      card.brief,
    )
  }

  return parts.join('\n\n')
}
