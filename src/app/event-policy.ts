import type { TitanEvent } from './model.ts'

export function durableEvent({ event }: { event: TitanEvent }): boolean {
  switch (event.type) {
    case 'task.edited':
      return !event.data.source
    case 'session.observed':
      return 'fields' in event.data && event.data.run !== undefined
    case 'card.observed':
    case 'titan.received':
    case 'titan.delivered':
    case 'titan.agent-used':
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
    case 'card.noted':
      return event.actor !== 'harvest' || event.data.kind !== 'context'
    default:
      return true
  }
}
