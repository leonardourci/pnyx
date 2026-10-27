import type { ProjectRefresh } from '../projects/refresh-types.ts'
import type { HelperChange, HelperState } from '../helper/state.ts'
import type { ExternalSourceEvent } from '../external-sources/model.ts'
import { EVENT_VERSION } from '../core/model.ts'
import type { EventBase, TaskQueue, Column, HydraConfig, HydraColumn, HydraProject, TaskCopy, OwnerAsk, TaskKind, AnswerMessage, ReportCall, LandingRule, HydraMessage, TaskDeclaration, Ask, FirstmateRecord, AgentLaunch, HydraStatus, DispatchProposal, AgentConfig, SteeringEvent, PushedEvent, MovedEvent, LinkedEvent, OutcomeEvent, RepliedEvent, NotedEvent, ViewEvent, SessionEvent, ChatEvent, PermissionEvent, SavedLabelColor, ViewPreferences, Card, AgentSession } from '../core/model.ts'

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
    }
  }
  | {
    type: 'board.configured'
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
      parentId?: string
      column?: Column
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
    }
  }
  | {
    type: 'task.reminder-due'
    data: {
      reminder: string
      column: Column
      message: Omit<HydraMessage, 'id' | 'at' | 'actor'>
    }
  }
  | {
    type: 'task.intent'
    data: OwnerAsk
  }
  | {
    type: 'task.brief'
    data: {
      before: string
      after: string
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
    data: Omit<Ask, 'at' | 'actor' | 'escalated' | 'answered' | 'answeredAt' | 'fromMessage' | 'choice' | 'closed'>
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
  | import('../compaction/model.ts').CompactionEvent
  | ExternalSourceEvent
  | SteeringEvent
  | PushedEvent
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
  'session.compaction',
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
  'task.intent',
  'task.visibility',
  'task.retention',
  'hydra.memory',
  'task.declared',
  'task.asked',
  'task.ask.escalated',
  'task.ask.closed',
  'task.ask.reopened',
  'task.mirrored',
  'hydra.message',
  'hydra.status',
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
  }
  hydraMessages?: HydraMessage[]
  // seq is the event that set it, so a recap can list what came after Hydra went down.
  hydraStatus?: HydraStatus & { seq: number }
  hydraMemory?: Record<string, {
    text: string
    at: string
  }>
  view?: ViewPreferences
  viewRevision?: number
  v: typeof EVENT_VERSION
  seq: number
  cards: Record<string, Card>
  sessions?: Record<string, AgentSession>
  keys: Record<string, string>
  // event id -> seq, so a retried or respooled event is applied once.
  // ponytail: grows with the log; move to a per-segment index if snapshots get large.
  eventIds: Record<string, number>
  // undone event id -> id of the event that reversed it
  undone: Record<string, string>
}
