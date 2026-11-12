import { ownerActor } from '#app/actors.ts'
import type { HydraState } from '#app/model.ts'
import { hydraChatQueue } from './chat-queue.ts'
import { hydraConfig } from './config.ts'

const hosted = ({
  state,
  id,
}: {
  state: HydraState
  id: string
}) => state.eventIds[`${id}:hosted`] ?? state.eventIds[`${id}:compact:hosted`]

// The owner's messages Hydra took with this input: the input itself, and earlier ones that never get an input of
// their own (sent while Hydra was down, task context, question discussions), which reach it in the next one.
export function receivedWith({
  state,
  input,
  pending,
}: {
  state: HydraState
  input: string
  // Messages still waiting for their own input.
  pending: ReadonlySet<string>
}): string[] {
  const through = hosted({
    state,
    id: input,
  })
  const config = hydraConfig({ state })
  const { held } = hydraChatQueue({ state })

  const carried = ({ id }: { id: string }) => {
    const seq = state.eventIds[id]

    return through !== undefined && seq !== undefined && seq < through && hosted({
      state,
      id,
    }) === undefined && !held.includes(id) && !pending.has(id)
  }

  return (state.hydraMessages ?? []).filter(message => message.hydra === config.hydra.id
    && ownerActor({ actor: message.actor }) && !message.received
    && (message.id === input || carried({ id: message.id })))
    .map(message => message.id)
}
