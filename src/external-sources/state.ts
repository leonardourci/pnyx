import type { Card, HydraEvent, HydraState } from '../core/model.ts'

export function sourceDeadline({ state }: { state: HydraState }): number | undefined {
  const deadlines = Object.values(state.cards).flatMap(card =>
    (card.externalSources ?? []).filter(source => source.state === 'registered')
      .map(source => Date.parse(source.expiresAt)))

  return deadlines.length ? Math.min(...deadlines) : undefined
}

export function sourceHeld({ card }: { card: Card }): boolean {
  return Boolean(card.hold || (card.status?.state === 'paused' && card.status.hold))
}

export function applyExternalSource({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (!event.type.startsWith('task.source.')) {
    return false
  }

  const card = state.cards[event.cardId]

  if (!card) {
    return true
  }

  if (event.type === 'task.source.registered') {
    const sources = card.externalSources ?? []

    if (sources.some(source => source.id === event.data.source.id)) {
      return true
    }

    card.externalSources = [
      ...sources,
      structuredClone(event.data.source),
    ]
  } else if (event.type === 'task.source.started' || event.type === 'task.source.result'
    || event.type === 'task.source.alerted' || event.type === 'task.source.handled') {
    const source = card.externalSources?.find(source => source.id === event.data.source)

    if (!source) {
      return true
    }

    if (event.type === 'task.source.started') {
      source.run = structuredClone(event.data.run)
      source.runs++
      source.state = 'running'
    } else if (event.type === 'task.source.result') {
      if (source.results.some(result => result.run === event.data.result.run)) {
        return true
      }

      source.results.push(structuredClone(event.data.result))
      source.state = 'ended'
      delete source.run
    } else {
      const result = source.results.find(result => result.sequence === event.data.sequence)

      if (!result) {
        return true
      }

      if (event.type === 'task.source.alerted') {
        result.alerted = event.data.detail
      } else {
        result.handled = structuredClone(event.data.handled)
        source.state = result.terminal ? 'retired' : 'registered'
      }
    }
  }

  card.revision++
  card.updatedAt = event.at
  card.updatedSeq = event.seq

  return true
}
