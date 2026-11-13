import { EVENT_VERSION, type EventBase } from '#store/events.ts'
import type { ViewEvent, ViewPreferences } from '#preferences/model.ts'
import type { HydraProject, TaskCopy } from '#projects/model.ts'
import type { FirstmateRecord } from '#integrations/firstmate/model.ts'
import type { ReportCall } from '#investigations/model.ts'
import type { Column, HydraColumn } from '#tasks/columns-model.ts'
import type { OwnerAsk, TaskKind, AnswerMessage, TaskDeclaration, Ask, PushedEvent, ObservedEvent, MovedEvent, RepliedEvent, NotedEvent, SavedLabelColor, Card, ReminderRepeat } from '#tasks/model.ts'
import type { LandingRule, LinkedEvent, OutcomeEvent } from '#tasks/delivery/model.ts'
import type { TaskQueue, AgentLaunch, DispatchProposal, AgentConfig, SteeringEvent, SessionEvent, PermissionEvent, AgentSession } from '#workers/model.ts'
import type { HydraConfig, HydraMessage, HydraOperation, HydraStatus, ChatEvent } from '#hydra/model.ts'
import type { ProjectRefresh } from '#projects/refresh-types.ts'
import type { HelperChange, HelperState } from '#routine-helper/state.ts'
import type { ExternalSourceEvent } from '#task-sources/model.ts'
import type { RecoveryEvent, RecoveryAttempt } from '#diagnostics/recovery-state.ts'

export type Decision = { event: HydraEvent } | { skipped: 'unchanged' | 'stale' | 'duplicate' }

// Where an observation came from. generation and observedAt order observations of
// the same source object so a late, older observation cannot overwrite a newer one.
export interface SourceRef {
  adapter: string
  instanceId?: string
  objectId: string
  generation?: number
  cursor?: string
  observedAt?: string
}

export type HydraChange = EventBase & (
  | {
    type: 'task.tools-applied'
    data: { revision: string }
  }
  | {
    type: 'task.tools'
    data: {
      before: string[]
      after: string[]
    }
  }
  | {
    type: 'task.wait-resumed'
    data: {
      wait: string
      message: import('#workers/model.ts').SteeringMessage
    }
  }
  | {
    type: 'hydra.context-delivered'
    data: {
      through: number
      ids?: string[]
    }
  }
  | RecoveryEvent
  | {
    type: 'project.refreshed'
    data: ProjectRefresh
  }
  | {
    type: 'task.dependencies'
    data: {
      before: string[]
      after: string[]
    }
  }
  | HelperChange
  | {
    type: 'task.queue'
    data: {
      before: TaskQueue | null
      after: TaskQueue | null
      order?: string[]
      column: Column
      note?: string
    }
  }
  | {
    type: 'hydra.review'
    data: {
      block: string
      reminders: string[]
      flags?: string[]
      wake?: boolean
    }
  }
  | {
    type: 'board.configured'
    nativeInput?: {
      tasks?: string[]
      epoch: string
      id: string
      text: string
      original?: string
    }
    data: HydraConfig
  }
  | {
    type: 'board.columns'
    data: {
      columns: HydraColumn[]
      before?: HydraColumn[]
      fallback?: Column
      placements?: Record<string, {
        before: Column | null
        after: Column | null
      }>
    }
  }
  | {
    type: 'hydra.project'
    data: {
      before: HydraProject | null
      after: HydraProject
      sharedWith: {
        id: string
        name: string
        url: string
      }[]
    }
  }
  | {
    type: 'task.project'
    data: {
      before: string | null
      after: string | null
    }
  }
  | import('#tasks/move-state.ts').HydraMoveEvent
  | {
    type: 'task.copy'
    data: {
      before: TaskCopy | null
      after: TaskCopy
    }
  }
  | {
    type: 'task.created'
    data: {
      hold?: string
      ask?: OwnerAsk
      key: string
      title: string
      brief?: string
      // The card's first Intent: what the owner wants from the task and why, written by Hydra.
      intent?: string
      parentId?: string
      column?: Column
      rank?: number
      folder?: string
      project?: string
      kind?: TaskKind
    }
  }
  | {
    type: 'task.held'
    data: { reason: string }
  }
  | {
    type: 'task.released'
    data: {
      hold: string
      answers?: string
      message: AnswerMessage
    }
  }
  | {
    type: 'task.kind'
    data: {
      before: TaskKind
      after: TaskKind
    }
  }
  | {
    type: 'task.report'
    data: {
      text: string
    }
  }
  | {
    type: 'task.report-reviewed'
    data: {
      report: string
      calls: ReportCall[]
    }
  }
  | {
    type: 'task.landing'
    data: {
      before: LandingRule | null
      after: LandingRule | null
    }
  }
  | {
    type: 'task.reminder'
    data: {
      before: string | null
      after: string | null
      repeat?: ReminderRepeat
    }
  }
  | {
    type: 'task.reminder-due'
    data: {
      reminder: string
      nextAt?: string | null
      grouped?: boolean
      column: Column
      message: Omit<HydraMessage, 'id' | 'at' | 'actor'>
    }
  }
  | {
    // Logs written before the card's Intent existed record an owner ask as task.intent.
    type: 'task.owner-ask' | 'task.intent'
    data: OwnerAsk
  }
  | {
    type: 'task.brief'
    data: {
      before: string
      after: string
      // Hydra's rewrite of the card's Intent when the goal itself changed; older ones stay in the log.
      intent?: string
    }
  }
  | {
    type: 'task.retention'
    data: {
      before: number | null
      after: number | null
    }
  }
  | {
    type: 'task.visibility'
    data: {
      before: boolean
      after: boolean
      automatic?: boolean
    }
  }
  | {
    type: 'hydra.memory'
    data: {
      key: string
      before: string | null
      after: string | null
    }
  }
  | {
    type: 'task.declared'
    data: Omit<TaskDeclaration, 'id' | 'at' | 'actor'>
  }
  | {
    type: 'task.asked'
    data: Omit<Ask, 'at' | 'actor' | 'escalated' | 'answered' | 'answeredAt' | 'fromMessage' | 'choice' | 'closed' | 'mergeHold' | 'reaskedAt' | 'answerRound' | 'deferredUntil' | 'deferredFromMessage'>
  }
  | {
    type: 'task.ask.deferred'
    data: {
      ask: string
      until: string | null
      fromMessage?: AnswerMessage
    }
  }
  | {
    type: 'task.ask.closed'
    data: {
      ask: string
      reason: string
      evidence: string
    }
  }
  | {
    type: 'task.ask.reopened'
    data: {
      ask: string
      answer: string
      reask?: boolean
    }
  }
  | {
    type: 'task.ask.escalated'
    data: {
      ask: string
      question?: string
      context?: string
    }
  }
  | {
    type: 'task.mirrored'
    data: FirstmateRecord
  }
  | {
    type: 'task.launched'
    data: AgentLaunch
  }
  | {
    type: 'hydra.message'
    data: Omit<HydraMessage, 'id' | 'at' | 'actor'>
  }
  | {
    type: 'hydra.status'
    data: HydraStatus
  }
  | {
    // Hydra's harness confirmed it took this message.
    type: 'hydra.received'
    data: {
      message: string
      // When Hydra's harness took it, by its own record.
      at: string
    }
  }
  | {
    type: 'hydra.agent-used'
    data: import('#workers/model.ts').AgentConfig
  }
  | {
    type: 'hydra.agent-change'
    data: import('#hydra/model.ts').HydraAgentChange
  }
  | {
    type: 'hydra.operation'
    data: HydraOperation
  }
  | {
    type: 'hydra.dispatch-proposed'
    data: DispatchProposal
  }
  | {
    type: 'hydra.dispatch-progress'
    data: {
      token: string
      status: 'applying' | 'failed'
      error?: string
    }
  }
  | {
    type: 'hydra.dispatch-resolved'
    data: {
      token: string
      action: 'confirmed' | 'dismissed'
    }
  }
  | {
    type: 'board.agents'
    data: {
      agents: Record<string, AgentConfig>
      before: Record<string, AgentConfig>
    }
  }
)

export type HydraEvent =
  | import('./transactions.ts').ApplyRecordedEvent
  | import('#workers/compaction/model.ts').CompactionEvent
  | import('#upgrade/model.ts').UpgradeEvent
  | ExternalSourceEvent
  | SteeringEvent
  | PushedEvent
  | ObservedEvent
  | MovedEvent
  | LinkedEvent
  | OutcomeEvent
  | RepliedEvent
  | NotedEvent
  | ViewEvent
  | SessionEvent
  | HydraChange
  | ChatEvent
  | PermissionEvent

export type EventType = HydraEvent['type']

export const EVENT_TYPES: readonly EventType[] = [
  'task.wait-resumed',
  'hydra.context-delivered',
  'diagnostic.retry',
  'apply.recorded',
  'session.compaction',
  'pnyx.upgrade',
  'task.source.registered',
  'task.source.lavish.published',
  'task.source.started',
  'task.source.result',
  'task.source.alerted',
  'task.source.handled',
  'project.refreshed',
  'task.steering.queued',
  'task.steering.notified',
  'task.steering.handled',
  'task.steering.recovery',
  'card.pushed',
  'card.observed',
  'card.moved',
  'card.linked',
  'card.outcome',
  'card.replied',
  'card.noted',
  'board.view',
  'task.session',
  'board.configured',
  'board.columns',
  'task.created',
  'task.brief',
  'task.owner-ask',
  'task.intent',
  'task.visibility',
  'task.retention',
  'hydra.memory',
  'task.declared',
  'task.tools',
  'task.tools-applied',
  'task.asked',
  'task.ask.escalated',
  'task.ask.closed',
  'task.ask.deferred',
  'task.ask.reopened',
  'task.mirrored',
  'hydra.message',
  'hydra.status',
  'hydra.received',
  'hydra.operation',
  'hydra.agent-used',
  'hydra.agent-change',
  'hydra.review',
  'hydra.helper-started',
  'hydra.helper-finished',
  'hydra.helper-acknowledged',
  'hydra.dispatch-proposed',
  'hydra.dispatch-resolved',
  'hydra.dispatch-progress',
  'chat.message',
  'board.agents',
  'task.launched',
  'task.permission',
  'hydra.project',
  'task.project',
  'task.reminder',
  'task.reminder-due',
  'task.copy',
  'task.moved-out',
  'task.moved-in',
  'task.queue',
  'task.dependencies',
  'task.held',
  'task.released',
  'task.kind',
  'task.report',
  'task.report-reviewed',
  'task.landing',
]

export interface HydraState {
  contextNotes?: import('#hydra/context-notes.ts').ContextNote[]
  diagnosticRetries?: Record<string, RecoveryAttempt[]>
  dispatchProposals?: DispatchProposal[]
  labelColors?: SavedLabelColor[]
  projects?: HydraProject[]
  projectsRevision?: number
  config?: HydraConfig
  // Set once a board.configured event applies; a column edit alone does not configure Hydra.
  configured?: boolean
  configRevision?: number
  helper?: HelperState
  hydraReview?: {
    at: string
    seq: number
    block: string
    reminders: Record<string, string>
    flags?: string[]
  }
  hydraMessages?: HydraMessage[]
  // The page's stand-in for hydraMessages: the owner's latest message to Hydra.
  hydraOwnerMessage?: Pick<HydraMessage, 'id' | 'task' | 'text'>
  questionReminders?: Record<string, string>
  hydraAgent?: import('#workers/model.ts').AgentConfig
  hydraAgentChange?: import('#hydra/model.ts').HydraAgentChange
  historyMilestones?: import('#hydra/history.ts').HistoryMilestone[]
  hydraContext?: {
    after: number
    summary: string
    previousSession?: string
  }

  upgrades?: import('#upgrade/model.ts').UpgradeOperation[]
  // seq is the event that set it, so a recap can list what came after Hydra went down.
  hydraStatus?: HydraStatus & { seq: number }
  // The operation stopping Hydra now; everything addressed to Hydra waits until it ends. seq is its start.
  hydraOperation?: Pick<HydraOperation, 'id' | 'kind'> & {
    since: string
    seq: number
  }
  hydraMemory?: Record<string, {
    text: string
    at: string
  }>
  view?: ViewPreferences
  viewRevision?: number
  v: typeof EVENT_VERSION
  seq: number
  cards: Record<string, Card>
  // Only on the page: hidden tasks without their histories, for the cards and messages that name them.
  references?: Record<string, Card>
  // Cards this Hydra handed to another one; the source log keeps their earlier events.
  movedOut?: Record<string, import('#tasks/move-state.ts').MovedOut>
  sessions?: Record<string, AgentSession>
  keys: Record<string, string>
  // event id -> seq, so a retried or respooled event is applied once.
  // ponytail: grows with the log; move to a per-segment index if snapshots get large.
  eventIds: Record<string, number>
  // undone event id -> id of the event that reversed it
  undone: Record<string, string>
}
