import type { HydraEvent } from './model.ts'

export function durableEvent({ event }: { event: HydraEvent }): boolean {
  switch (event.type) {
    case 'card.pushed':
    case 'session.observed':
    case 'task.declared':
    case 'hydra.received':
    case 'hydra.delivered':
    case 'hydra.agent-used':
    case 'hydra.context-delivered':
    case 'hydra.helper-started':
    case 'hydra.helper-finished':
    case 'hydra.helper-acknowledged':
    case 'hydra.operation':
    case 'hydra.status':
    case 'hydra.dispatch-progress':
    case 'task.steering.notified':
    case 'task.steering.handled':
    case 'task.steering.recovery':
    case 'project.refreshed':
      return false
    case 'card.moved':
      return !event.derived
    case 'card.noted':
      return event.actor !== 'harvest' || event.data.kind !== 'context'
    default:
      return true
  }
}
