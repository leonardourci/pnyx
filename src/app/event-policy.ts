import type { TitanEvent } from './model.ts'

export function durableEvent({ event }: { event: TitanEvent }): boolean {
  switch (event.type) {
    case 'task.edited':
      return !event.data.source
    case 'card.observed':
    case 'session.observed':
    case 'titan.received':
    case 'titan.delivered':
    case 'titan.agent-used':
    case 'titan.context-delivered':
    case 'titan.helper-started':
    case 'titan.helper-finished':
    case 'titan.helper-acknowledged':
    case 'titan.status':
    case 'titan.dispatch-progress':
    case 'task.steering.notified':
    case 'task.steering.recovery':
    case 'project.refreshed':
      return false
    case 'titan.operation':
      return event.data.kind === 'compaction'
    case 'task.steering.handled':
      return !event.derived
    case 'card.noted':
      return event.actor !== 'harvest' || event.data.kind !== 'context'
    default:
      return true
  }
}
