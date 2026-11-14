import { ownerActor } from '#app/actors.ts'
import type { HydraState } from '#app/model.ts'
import { hydraConfig } from './config.ts'

// The owner's messages Hydra took with this input: the input itself and the ones its text lists, such as a recap's.
export function receivedWith({
  state,
  input,
  carried,
}: {
  state: HydraState
  input: string
  carried: readonly string[]
}): string[] {
  const config = hydraConfig({ state })
  const taken = new Set([
    input,
    ...carried,
  ])

  return (state.hydraMessages ?? []).filter(message => message.hydra === config.hydra.id
    && ownerActor({ actor: message.actor }) && !message.received
    && taken.has(message.id))
    .map(message => message.id)
}
