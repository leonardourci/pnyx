import type { RepliedEvent } from '#tasks/model.ts'
import type { EventBase } from '#store/events.ts'
import type { Outcome } from '#tasks/delivery/model.ts'
import type { SourceRef } from '#app/model.ts'
import type { TaskCopy } from '#projects/model.ts'
import type { Column } from '#tasks/columns-model.ts'

// queued: recorded before the send. delivery_unknown: the route could not confirm
// the send either way, so it is never resent blindly.
export const REPLY_STATES = [
  'queued',
  'delivered',
  'delivery_unknown',
  'failed',
] as const

export type ReplyState = (typeof REPLY_STATES)[number]

export interface AgentRef {
  provider: string
  sessionId: string
  agentId?: string
  agentType?: string
  cwd?: string
  transcriptPath?: string
  account?: string
  loginFolder?: string
  paseoAgentId?: string
  paseoUrl?: string
  // Set when the Pnyx server runs this agent itself instead of a terminal.
  host?: 'pnyx'
  // An adopted native session must resume even when its transcript is unavailable.
  resume?: true
}

export type AgentSettings = Record<string, string>

export interface TerminalFacts {
  tty?: string
  pid?: string
  program?: string
  tmux?: string
  tmuxPane?: string
  paseoTerminal?: string
  paseoHome?: string
  herdrSession?: string
  herdrPane?: string
}

export interface Question {
  question: string
  header?: string
  options: {
    label: string
    description?: string
  }[]
  multiSelect?: boolean
  // Its answer reaches the agent but is never recorded.
  secret?: boolean
}

export const FORM_FIELD_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
] as const

export interface FormField {
  name: string
  title?: string
  type: (typeof FORM_FIELD_TYPES)[number]
  options?: string[]
  required?: boolean
}

// An explicit source request. A blocking one (a question, a permission prompt)
// waits on the user before the agent can go on.
export interface Attention {
  kind: string
  key: string
  blocking: boolean
  text?: string
  questions?: Question[]
  form?: FormField[]
  // The reply that answered it from the Hydra. The request stays until the session's
  // own hooks close it, but no longer counts as waiting on anyone.
  answered?: string
}

// A reply's latest receipt. The text stays in the log, on its queued event.
export interface Reply {
  decision?: RepliedEvent['data']['decision']
  id: string
  state: ReplyState
  answers?: string
  resumes?: boolean
  route?: string
  detail?: string
}

export interface SteeringClaim {
  session: string
  generation: number
}

export interface SteeringAttempt {
  id: string
  at: string
  actor: string
  claim: SteeringClaim
  result: 'delivered' | 'unknown' | 'failed' | 'deferred'
  detail?: string
}

export interface SteeringAck {
  at: string
  actor: string
  claim: SteeringClaim
  outcome: 'read' | 'incorporated' | 'blocked'
  note?: string
}

export interface SteeringRecovery {
  id: string
  at: string
  claim?: SteeringClaim
  result: 'reserved' | 'delivered' | 'unknown' | 'failed' | 'deferred' | 'exhausted'
  detail?: string
}

export interface SteeringMessage {
  id: string
  order: number
  text: string
  source: string
  reply?: string
  at: string
  actor: string
  queuedFor?: SteeringClaim
  attempts: SteeringAttempt[]
  recovery?: SteeringRecovery[]
  ack?: SteeringAck
}

export type SteeringEvent = EventBase & (
  | {
    type: 'task.steering.recovery'
    data: {
      message: string
      recovery: SteeringRecovery
    }
  }
  | {
    type: 'task.steering.queued'
    data: { message: SteeringMessage }
  }
  | {
    type: 'task.steering.notified'
    data: {
      message: string
      attempt: SteeringAttempt
    }
  }
  | {
    type: 'task.steering.handled'
    data: {
      message: string
      ack: SteeringAck
    }
  }
)

export interface PermissionRequest {
  id: string
  nativeId?: string
  session: string
  tool: string
  input: Record<string, unknown>
  description?: string
  status: 'pending' | 'allow' | 'deny' | 'expired'
  // Set when the agent asks the owner questions or fills a form instead of asking to run a tool.
  questions?: Question[]
  form?: FormField[]
  // The answer that allowed it: each question's picked labels or typed text, or the form's values.
  answers?: string[][]
  values?: Record<string, string | number | boolean>
  // When the request was first recorded, so a stalled one can be noticed.
  at?: string
}

export type PermissionEvent = EventBase & {
  type: 'task.permission'
  data: PermissionRequest
}

export const HARNESS_NAMES = [
  'claude',
  'codex',
] as const

export const QUOTA_BUCKETS = [
  'high',
  'medium',
  'low',
] as const

export interface AgentConfig {
  harness: (typeof HARNESS_NAMES)[number]
  model?: string
  effort?: string
  mode?: string
  fast?: boolean
  quota?: (typeof QUOTA_BUCKETS)[number]
}

// A task's own copy of its project: a git worktree Pnyx made, or the folder the
// project's copy command printed. It is removed only once its work has landed.
export interface TaskQueue {
  session: string
  rank: number
}

// Settings a start asks for in place of its heads dispatch candidate's own.
export type StartOverride = Partial<Pick<AgentConfig, 'model' | 'effort' | 'mode' | 'fast'>>

export interface AgentLaunch {
  dispatch?: string
  override?: StartOverride
  via: 'paseo' | 'command' | 'hooks' | 'pnyx'
  at: string
  folder?: string
  command?: string
  pid?: number
  harness?: string
}

export interface AgentSession {
  id: string
  agent: AgentRef
  launch?: AgentLaunch
  lastSeen?: string
  originCardId: string
  queueCompleted?: number
  taskId: string | null
  terminal?: TerminalFacts
  settings?: AgentSettings
  activity?: string
  sessionActivity?: string
  workingSince?: string
  stoppedAt?: string
  attention: Attention[]
  outcome?: Outcome
  sourceRefs: SourceRef[]
}

export type SessionEvent = EventBase & {
  type: 'task.session'
  data: {
    session: string
    before: string | null
    after: string | null
    brief?: string
    working?: boolean
    handoff?: {
      folder: string
      copy?: TaskCopy
      column: Column
    }
  }
}

export interface DispatchProposal {
  token: string
  kind: 'rule' | 'account' | 'command'
  shared: boolean
  before: string
  value: string
  summary: string
  status?: 'applying' | 'failed'
  error?: string
}
