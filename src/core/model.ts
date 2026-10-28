import type { SourceRef } from '../app/model.ts'
import type { EventBase } from '../store/events.ts'
import type { HydraProject, TaskCopy } from '../projects/model.ts'
import type { Column, HydraColumn } from '../tasks/columns-model.ts'
import type { AnswerMessage, Card } from '../tasks/model.ts'

export const LINK_KINDS = [
  'github_pr',
  'linear',
  'url',
] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export const LINK_STATES = [
  'open',
  'merged',
  'closed',
] as const
export type LinkState = (typeof LINK_STATES)[number]

// The outcomes a person or agent records. "ended" is observed only: a harness
// reporting its session closed.
export const OUTCOME_STATES = [
  'done',
  'failed',
  'cancelled',
] as const
export type OutcomeState = (typeof OUTCOME_STATES)[number] | 'ended'

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

export interface Link {
  kind: LinkKind
  url: string
  number?: number
  title?: string
  state?: LinkState
  checkedAt?: string
  draft?: boolean
  // A followed pull request's last seen checks summary and comment count, so only changes reach its worker.
  checks?: string
  comments?: number
  mergeAttempt?: {
    outcome: 'merged' | 'queued' | 'unknown'
    head: string
    requestedAt: string
    detail?: string
  }
  mergeProof?: {
    head: string
    commit: string
    confirmedAt: string
  }
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

// closed: the source closed the task, so even a failure is final and needs no one.
// source: the adapter that observed the outcome; only that source may change it.
export interface Outcome {
  state: OutcomeState
  note?: string
  closed?: boolean
  source?: string
}

// A reply's latest receipt. The text stays in the log, on its queued event.
export interface Reply {
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
  outcome: 'incorporated' | 'blocked'
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

export interface HydraIdentity {
  agent?: AgentConfig
  id: string
  kind: 'agent' | 'firstmate'
  name: string
  session?: string
  home?: string
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
// How a project's work lands: a pull request, or a commit on the task's branch only.
export const LANDINGS = [
  'pr',
  'branch',
] as const
export type Landing = (typeof LANDINGS)[number]

// Who merges a project's pull requests: the owner, or Hydra once every check is green.
export const MERGERS = [
  'owner',
  'hydra',
] as const
export type Merger = (typeof MERGERS)[number]

export interface LandingRule {
  landing: Landing
  merge: Merger
}

const DEFAULT_LANDING: Landing = 'pr'
const DEFAULT_MERGER: Merger = 'owner'

// A project saved before landing rules lands through a pull request the owner merges.
export function landingRule({ project }: { project: Pick<HydraProject, 'landing' | 'merge'> }): LandingRule {
  return {
    landing: project.landing ?? DEFAULT_LANDING,
    merge: project.merge ?? DEFAULT_MERGER,
  }
}

// The owner's rule for this task when one was recorded, otherwise its project's.
export function cardLanding({
  card,
  projects,
}: {
  card: Card
  projects: HydraProject[]
}): LandingRule | undefined {
  if (card.landing) {
    return card.landing
  }

  const project = projects.find(p => !p.detached
    && (p.path === card.project || p.name === card.project))

  return project ? landingRule({ project }) : undefined
}

// gh-axi's checks line ("3 passed, 1 failed, 1 skipped, 6 total"), counted.
function checkTally({ checks }: { checks?: string }) {
  const count = ({ word }: { word: string }) => Number(new RegExp(`(\\d+) ${word}`).exec(checks ?? '')?.[1] ?? 0)

  return {
    passed: count({ word: 'passed' }),
    failed: count({ word: 'failed' }),
    skipped: count({ word: 'skipped' }),
    total: count({ word: 'total' }),
  }
}

export function failedChecks({ checks }: { checks?: string }): number {
  return checkTally({ checks }).failed
}

// Whatever is neither passed, failed nor skipped is still running.
export function pendingChecks({ checks }: { checks?: string }): number {
  const {
    passed,
    failed,
    skipped,
    total,
  } = checkTally({ checks })

  return Math.max(
    0,
    total - passed - failed - skipped,
  )
}

// At least one check passed or failed, so the line reports a real run rather than none or only skips.
export function ranChecks({ checks }: { checks?: string }): boolean {
  const {
    passed,
    failed,
  } = checkTally({ checks })

  return passed + failed > 0
}

// A task's own copy of its project: a git worktree Pnyx made, or the folder the
// project's copy command printed. It is removed only once its work has landed.
export interface TaskQueue {
  session: string
  rank: number
}

export interface HydraConfig {
  helper?: AgentConfig | false
  id: string
  name: string
  hydra: HydraIdentity
  columns: HydraColumn[]
  // Retained so pre-dispatch event logs still replay.
  agents?: Record<string, AgentConfig>
  command?: string
  // The command makes its own folder, so starts through it skip the task copy.
  commandOwnsFolder?: boolean
  doneAfterHours?: number
  reviewMinutes?: number
}
export interface HydraMessage {
  id: string
  task?: string
  action: 'send' | 'worker'
  // A worker's progress report: it stays on the card and reaches Hydra with its next wake, never waking it alone.
  kind?: 'progress'
  text: string
  enteredText?: string
  details?: string
  context?: string
  // ask: the worker question this message delivers; answers: Hydra's question this owner message answers.
  ask?: string
  answers?: string
  fromMessage?: AnswerMessage
  choice?: string
  at: string
  actor: string
  hydra: string
}
// Whether Pnyx can start the Hydra it runs: down from a failed start until a start works again.
export interface HydraStatus {
  state: 'down' | 'up'
  since: string
  detail?: string
  // Down only: the last change before the message or wake that met the failure; the recap lists what came after it.
  after?: number
}

export type LinkedEvent = EventBase & {
  type: 'card.linked'
  data: {
    url: string
    before: Link | null
    after: Link | null
  }
}
// Keeps the card's title, workspace, tags and links as they were when the outcome
// was recorded, so history stays readable after later edits.
export type OutcomeEvent = EventBase & {
  type: 'card.outcome'
  data: {
    before: Outcome | null
    after: Outcome | null
    card: {
      title: string
      workspace: string
      tags: string[]
      links: Link[]
    }
  }
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

export type ChatEvent = EventBase & {
  type: 'chat.message'
  data: {
    session: string
    nativeId: string
    role: string
    text: string
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
