import { declaredState } from '../core/hydra.ts'
import {
  HYDRA_ACTOR,
  type HydraEvent,
} from '../core/model.ts'
import { landingWording } from '../tasks/delivery/cli.ts'

export function summarize({ event }: { event: HydraEvent }): string {
  const text = summary({ event })

  return event.reason ? `${text} (why: ${event.reason})` : text
}

function summary({ event }: { event: HydraEvent }): string {
  const undo = event.undoes ? `undo ${event.undoes}: ` : ''

  switch (event.type) {
    case 'session.compaction': return event.data.kind === 'status' ? `Compaction ${event.data.operation.state}${event.data.operation.error ? `: ${event.data.operation.error}` : ''}` : `Compaction ${event.data.kind}`
    case 'task.source.registered': return `External source ${event.data.source.id} registered`
    case 'task.source.lavish.published': return `Lavish source ${event.data.source} reply ${event.data.reply} accepted`
    case 'task.source.started': return `External source ${event.data.source} run started`
    case 'task.source.result': return `External source ${event.data.source} result ${event.data.result.sequence}: ${event.data.result.outcome}`
    case 'task.source.alerted': return event.data.detail
    case 'task.source.handled': return `External source ${event.data.source} result ${event.data.sequence} handled`
    case 'project.refreshed': return `Project copy ${event.data.state}: ${event.data.path}${event.data.reason ? ` (${event.data.reason})` : ''}`
    case 'task.steering.recovery': return `Steering ${event.data.message} recovery: ${event.data.recovery.result}${event.data.recovery.detail ? `: ${event.data.recovery.detail}` : ''}`
    case 'task.steering.queued': return `Steering ${event.data.message.order} queued: ${event.data.message.id}`
    case 'task.steering.notified': return `Steering ${event.data.message} notification: ${event.data.attempt.result}`
    case 'task.steering.handled': return `Steering ${event.data.message} handled: ${event.data.ack.outcome}`
    case 'chat.message': return `${event.data.role}: ${event.data.text}`
    case 'board.configured': return `Hydra ${event.data.name}; Hydra ${event.data.hydra.id}`
    case 'board.columns': return `Columns: ${event.data.columns.map(c => c.title).join(', ')}`
    case 'hydra.project': return `${event.data.before && event.data.before.detached === event.data.after.detached ? 'Updated' : event.data.after.detached ? 'Detached' : 'Attached'} project ${event.data.after.name}: ${event.data.after.path}${event.data.sharedWith.length ? `; shared with Hydra ${event.data.sharedWith.map(h => h.name).join(', ')}` : ''}`
    case 'task.project': return `Task project: ${event.data.after ?? 'none'}`
    case 'task.kind': return event.data.after === 'build' ? 'Investigation turned into the build' : `Task kind: ${event.data.after}`
    case 'task.report-reviewed': return `Report decisions reviewed (${event.data.calls.length} calls)`
    case 'task.report': return `Report stored (${event.data.text.length} characters)`
    case 'task.landing': return event.data.after
      ? `For this task only: lands as ${landingWording({ rule: event.data.after })}`
      : 'Follows its project\'s landing rule again'
    case 'task.copy': return `Task copy ${event.data.after.state}: ${event.data.after.path}${event.data.after.reason ? ` (${event.data.after.reason})` : ''}`
    case 'task.created': return `Created ${event.data.parentId ? 'subtask' : 'task'}: ${event.data.title}`
    case 'task.permission': return `${event.data.tool} permission ${event.data.id}: ${event.data.status}`
    case 'task.reminder': return event.data.after ? `Reminder set for ${event.data.after}` : 'Reminder cleared'
    case 'task.reminder-due': return event.data.message.text
    case 'task.held': return `Held for discussion: ${event.data.reason}`
    case 'task.released': return `Released on owner message ${event.data.message.id}`
    case 'task.intent': return 'Owner ask added'
    case 'task.brief': return 'Task brief updated'
    case 'task.retention': return event.data.after === null ? 'Using the Hydra hide time' : event.data.after === 0 ? 'Keeping the Done card visible' : `Done card hidden after ${event.data.after} hours`
    case 'task.visibility': return event.data.after ? 'Task hidden from Hydra' : 'Task returned to Hydra'
    case 'hydra.helper-started': return 'Routine helper started'
    case 'hydra.helper-finished': return event.data.error ? `Helper handed back: ${event.data.error}` : 'Routine helper outcomes recorded'
    case 'hydra.helper-acknowledged': return 'Helper outcomes handled by Hydra'
    case 'hydra.review': return 'Timed review'
    case 'hydra.memory': return `${event.data.after === null ? 'Forgot' : 'Saved'} Hydra memory: ${event.data.key}`
    case 'task.declared': return `${declaredState({ declaration: event.data })}: ${event.data.note}`
    case 'task.asked': return `Asked ${event.data.audience === 'owner' ? 'the owner' : 'Hydra'} (${event.data.id}): ${event.data.question}`
    case 'task.ask.closed': return `Closed ${event.data.ask}: ${event.data.reason} (${event.data.evidence})`
    case 'task.ask.reopened': return `Reopened ${event.data.ask}`
    case 'task.ask.escalated': return `Escalated ${event.data.ask} to the owner${event.data.question ? `: ${event.data.question}` : ''}`
    case 'task.launched': return `Started through ${event.data.via} in ${event.data.folder ?? 'unknown folder'}`
    case 'task.mirrored': return `Mirrored Firstmate task ${event.data.task}`
    case 'hydra.dispatch-proposed': return `Proposed dispatch change: ${event.data.summary}`
    case 'hydra.dispatch-progress': return `Owner question ${event.data.status}${event.data.error ? `: ${event.data.error}` : ''}`
    case 'hydra.dispatch-resolved': return `Dispatch proposal ${event.data.action}`
    case 'hydra.message': return `${event.actor === HYDRA_ACTOR ? 'Hydra' : event.data.action === 'worker' ? 'Create a worker' : event.data.kind === 'progress' ? 'Progress' : 'Send to Hydra'}: ${event.data.text}${event.data.details ? ` (${event.data.details})` : ''}`
    case 'hydra.status': return `Hydra ${event.data.state} since ${event.data.since}${event.data.detail ? `: ${event.data.detail}` : ''}`
    case 'board.agents': return `Legacy agents: ${Object.keys(event.data.agents).join(', ') || 'none'}`
    case 'task.dependencies': return `Prerequisites: ${event.data.after.join(', ') || 'none'}`
    case 'task.queue': return event.data.after ? `queued for ${event.data.after.session}` : `unqueued${event.data.note ? `: ${event.data.note}` : ''}`
    case 'task.session': return `${undo}session ${event.data.session}: ${event.data.before ?? 'none'} -> ${event.data.after ?? 'none'}`
    case 'board.view': return 'View preferences changed'
    case 'card.pushed':
      return `${undo}${Object.keys(event.data).filter(k => k !== 'key' && k !== 'before')
        .join(' ') || 'no fields'}`
    case 'card.moved':
      return `${undo}${event.data.before ?? 'none'} -> ${event.data.after ?? 'none'}`
    case 'card.linked': {
      const l = event.data.after ?? event.data.before
      const label = l ? `${l.kind}${l.number ? ` #${l.number}` : ''}` : event.data.url
      const facts = [
        event.data.after?.checks === undefined ? '' : ` · checks ${event.data.after.checks}`,
        event.data.after?.comments === undefined ? '' : ` · ${event.data.after.comments} comments`,
      ].join('')

      return `${undo}${event.data.after ? `${label} ${event.data.after.state ?? 'unknown'}${facts}` : `removed ${label}`}`
    }
    case 'card.outcome':
      return `${undo}${event.data.after ? `${event.data.after.state}${event.data.after.note ? `: ${event.data.after.note}` : ''}` : 'cleared'}`
    case 'card.replied':
      return `reply ${event.data.reply} ${event.data.state}${event.data.detail ? `: ${event.data.detail}` : ''}`
    case 'card.noted':
      return `${event.data.kind} from ${event.data.source}`
  }
}
