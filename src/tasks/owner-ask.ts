import { inform } from '#app/command-notices.ts'
import { ownerActor } from '#app/actors.ts'
import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import type { Card, OwnerAsk } from './model.ts'

export function ownerAsk({
  state,
  task,
  text,
  message,
  actor,
  at,
}: {
  state: HydraState
  task?: string
  text: string
  message?: string
  actor: string
  at: string
}): OwnerAsk {
  if (!text.trim() || text.length > 24000) {
    throw new HydraError({
      message: 'The owner ask needs 1 to 24000 characters',
      field: 'text',
      code: 'VALIDATION_ERROR',
    })
  }

  if (message) {
    const source = state.hydraMessages?.find(entry => entry.id === message
      && ownerActor({ actor: entry.actor }))

    if (!source || !source.text.includes(text)) {
      throw new HydraError({
        message: 'Quote the saved owner message exactly',
        field: 'message',
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
    inform({
      task,
      reason: 'Ask recorded without a saved owner message',
      clear: 'pnyx task owner-ask <task> --text "<owner words>" --message <owner-message-id>',
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
