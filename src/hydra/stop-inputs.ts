import { applyDecision } from '#app/decision.ts'
import { ownerActor } from '#app/actors.ts'
import type { Writer } from '#app/writer.ts'
import { hydraEvent } from './hydra.ts'
import { HYDRA_CARD } from './identity.ts'

// Marks the owner's messages among ids as stopped, unless Hydra already received them.
export function stopHydraInputs({
  writer,
  ids,
  at,
}: {
  writer: Writer
  ids: readonly string[]
  at: string
}) {
  const messages = (writer.state.hydraMessages ?? [])
    .filter(message => ids.includes(message.id) && !message.received && !message.stopped
      && message.action === 'send' && ownerActor({ actor: message.actor }))
    .map(message => message.id)

  if (!messages.length) {
    return
  }

  applyDecision({
    writer,
    decision: hydraEvent({
      state: writer.state,
      cardId: HYDRA_CARD,
      meta: {
        at,
        actor: 'pnyx',
      },
      change: {
        type: 'hydra.input-stopped',
        data: { messages },
      },
    }),
  })
}
