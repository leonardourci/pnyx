import { ownerActor } from '#app/actors.ts'
import type { TitanState } from '#app/model.ts'
import { hydraConfig } from './config.ts'
import type { TitanMessage } from './model.ts'
import type { Writer } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { hydraEvent } from './titan.ts'
import { TITAN_CARD } from './identity.ts'

export function hydraDeliveryId({
  message,
  release = false,
}: {
  message: Pick<TitanMessage, 'id' | 'attempt'>
  release?: boolean
}) {
  const attempt = message.attempt ? `:retry:${message.attempt}` : ''
  const compact = release ? ':compact' : ''

  return `${message.id}${attempt}${compact}:hosted`
}

export function hydraInputDispatched({
  state,
  message,
}: {
  state: TitanState
  message: TitanMessage
}) {
  return Object.hasOwn(
    state.eventIds,
    hydraDeliveryId({ message }),
  )
    || Object.hasOwn(
      state.eventIds,
      hydraDeliveryId({
        message,
        release: true,
      }),
    )
}

export function failTitanInput({
  writer,
  input,
  error,
  at,
}: {
  writer: Writer
  input: string
  error: string
  at: string
}) {
  const message = writer.state.hydraMessages?.find(message => message.id === input)

  const owner = message && ownerActor({ actor: message.actor })

  if (!message || message.received || message.stopped || message.failure || !owner) {
    return
  }

  applyDecision({
    writer,
    decision: hydraEvent({
      state: writer.state,
      cardId: TITAN_CARD,
      meta: {
        actor: 'othrys',
        at,
      },
      change: {
        type: 'hydra.input',
        data: {
          message: input,
          state: 'failed',
          error,
        },
      },
    }),
  })
}

// The owner's messages Titan took with this input: the input itself and the ones its text lists, such as a recap's.
export function receivedWith({
  state,
  input,
  carried,
}: {
  state: TitanState
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
