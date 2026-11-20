import type { Card } from '#tasks/model.ts'
import type { HydraState } from '#app/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import { createPendingResource } from '#web-shared/pending-intents.ts'
import { argument } from '#web-tasks/optimistic.ts'

interface TurnSend {
  card: string
  message?: string
  afterSeq: number
  wasWorking: boolean
  turnStartedAt?: string
  stoppedAt?: string
}

export interface PendingTurn {
  error?: string
}

const observedTurn = ({
  cards,
  send,
}: {
  cards: Record<string, Card>
  send: TurnSend
}) => {
  const card = cards[send.card]

  if (!card) {
    return false
  }

  const working = (card.sessionActivity ?? card.activity) === 'working'
  const started = working && (!send.wasWorking || card.turnStartedAt !== send.turnStartedAt)
  const ended = (card.turnEndedSeq ?? 0) > send.afterSeq
  const stopped = card.stoppedAt !== undefined && card.stoppedAt !== send.stoppedAt

  return started || ended || stopped
}

export const createPendingTurns = ({ scope }: { scope: string }) => createPendingResource<
  Record<string, Card>, TurnSend
>({
  scope,
  confirmed: {},
  adapter: {
    project: ({ state }) => state,
    represented: ({
      state,
      intent,
    }) => observedTurn({
      cards: state,
      send: intent.patch,
    }),
  },
})

export function turnTarget({
  name,
  args,
  state,
}: {
  name: string
  args: string[]
  state: HydraState
}): string | undefined {
  if (name === 'hydra' && args[0] === 'send' && argument({
    args,
    flag: '--task',
  }) === undefined) {
    return HYDRA_CARD
  }

  let ref: string | undefined

  if (name === 'reply') {
    ref = args[0]
  } else if (name === 'task' && args[0] === 'send') {
    ref = args[1]
  }

  if (!ref) {
    return undefined
  }

  return state.keys[ref] ?? ref
}

export function pendingTurns({
  resource,
  hydraStatus,
}: {
  resource: ReturnType<typeof createPendingTurns>
  hydraStatus?: HydraState['hydraStatus']
}): Record<string, PendingTurn> {
  const snapshot = resource.snapshot()
  const latest = new Map<string, typeof snapshot.intents[number]>()

  for (const intent of snapshot.intents) {
    latest.set(
      intent.patch.card,
      intent,
    )
  }

  const pending: Record<string, PendingTurn> = {}

  for (const intent of latest.values()) {
    const card = snapshot.confirmed[intent.patch.card]
    const activity = card?.sessionActivity ?? card?.activity
    const hydraFailed = intent.patch.card === HYDRA_CARD && hydraStatus?.state === 'down'
      && hydraStatus.seq > intent.patch.afterSeq && activity !== 'working'
      && (card?.turnEndedSeq ?? 0) <= hydraStatus.seq

    if (hydraFailed) {
      pending[intent.patch.card] = { error: hydraStatus.detail ?? 'Hydra could not start a turn' }
      continue
    }

    const interrupted = card?.attention.find(item => item.key === INTERRUPTED)

    if (interrupted && activity === 'interrupted' && (card?.turnEndedSeq ?? 0) > intent.patch.afterSeq) {
      pending[intent.patch.card] = { error: interrupted.text ?? 'The agent stopped before starting this turn' }
      continue
    }

    const reply = card?.replies?.find(reply => reply.id === intent.patch.message)

    const currentFailure = reply?.state === 'failed' && (reply.updatedSeq ?? 0) > intent.patch.afterSeq
      && reply.turnStartedAt === card?.turnStartedAt

    if (currentFailure) {
      pending[intent.patch.card] = { error: reply.detail ?? 'Message could not start a turn' }
      continue
    }

    if (intent.stage === 'confirmed' || observedTurn({
      cards: snapshot.confirmed,
      send: intent.patch,
    })) {
      continue
    }

    pending[intent.patch.card] = { error: intent.stage === 'refused' ? intent.error?.message : undefined }
  }

  return pending
}
