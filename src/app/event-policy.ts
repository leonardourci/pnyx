import type { TitanEvent } from './model.ts'

export function durableEvent({ event }: { event: TitanEvent }): boolean {
  switch (event.type) {
    case 'task.edited':
      return !event.data.source
    case 'card.observed':
    case 'session.observed':
    case 'hydra.received':
    case 'hydra.delivered':
    case 'hydra.agent-used':
    case 'hydra.context-delivered':
    case 'hydra.helper-started':
    case 'hydra.helper-finished':
    case 'hydra.helper-acknowledged':
    case 'hydra.status':
    case 'hydra.dispatch-progress':
    case 'task.steering.notified':
    case 'task.steering.recovery':
    case 'project.refreshed':
      return false
    case 'hydra.operation':
      return event.data.kind === 'compaction'
    case 'task.steering.handled':
      return !event.derived
    case 'card.noted':
      return event.actor !== 'harvest' || event.data.kind !== 'context'
    default:
      return true
  }
}
