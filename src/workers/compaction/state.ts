import { sessionId } from '#workers/session-attachments.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'

export { compactCommand } from '#workers/compact-command.ts'

export const activeCompaction = ({ card }: { card?: Card }) => card?.agent
  ? card.compaction?.operations.findLast(operation => operation.state === 'running'
    && operation.session === sessionId({ agent: card.agent! })) : undefined

export function applyCompaction({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type !== 'session.compaction') {
    return false
  }

  const card = state.cards[event.cardId]

  if (!card) {
    return true
  }

  const compact = card.compaction ??= {
    operations: [],
    inputs: [],
  }
  const change = event.data

  if (change.kind === 'catalog') {
    (compact.catalogs ??= {})[change.key] = structuredClone(change.commands)
  } else if (change.kind === 'status') {
    const index = compact.operations.findIndex(operation =>
      operation.id === change.operation.id && operation.session === change.operation.session)
    const previous = compact.operations[index]

    if (previous && previous.state !== 'running') {
      return true
    }

    if (index < 0) {
      compact.operations.push(structuredClone(change.operation))
    } else {
      compact.operations[index] = structuredClone(change.operation)
    }

    if (change.operation.state === 'running' && change.operation.trigger === 'manual') {
      compact.inputs = compact.inputs.filter(input => input.route !== 'direct'
        || `manual:${input.id}` !== change.operation.id)
    }
  } else if (change.kind === 'held') {
    if (!compact.inputs.some(input => input.id === change.input.id)) {
      compact.inputs.push(structuredClone(change.input))
    }
  } else if (change.kind === 'taken') {
    compact.inputs = compact.inputs.filter(input => input.id !== change.id)
  } else if (change.kind === 'priority') {
    if (compact.inputs.some(input => input.id === change.id)) {
      compact.priority = change.id
    }
  }

  card.revision++
  card.updatedSeq = event.seq
  card.updatedAt = event.at

  return true
}
