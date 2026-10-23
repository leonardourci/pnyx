import type { TaskSpend } from '../spend/tasks.ts'

export const EVENT_VERSION = 1 as const
export const HYDRA_ACTOR = 'hydra'
// The Hydra page and an unlabelled CLI are usually the owner; workers Pnyx runs write as `worker:<task>`.
export const OWNER_ACTORS = [
  'web',
  'cli',
]
export const ownerActor = ({ actor }: { actor?: string }) => !actor || OWNER_ACTORS.includes(actor)

export const COLUMNS = [
  'queued',
  'in_progress',
  'needs_you',
  'parked',
  'done',
] as const
// Column ids earlier versions wrote; old logs still name them until the Hydra moves onto the defaults.
export const LEGACY_IN_PROGRESS = 'workers_on_it'
export const LEGACY_COLUMNS = [
  LEGACY_IN_PROGRESS,
  'review',
] as const
export type Column = (typeof COLUMNS)[number] | (typeof LEGACY_COLUMNS)[number] | `custom:${string}`

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

export const NOTE_KINDS = [
  'summary',
  'decision',
  'context',
] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

export const SESSION_TITLE = 'Session title: '

export const AUTO_TITLE_SOURCES = [
  'session',
  'prompt',
  'agent',
  'folder',
] as const

export interface AutoTitle {
  from: (typeof AUTO_TITLE_SOURCES)[number]
  text: string
}

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

export interface Note {
  kind: NoteKind
  source: string
  text: string
  at?: string
}

// A note as a source reader finds it; ref names the source record, so reading the
// same record again gives the same note id.
export interface SourceNote extends Note {
  ref: string
}

export interface NoteRef {
  id: string
  kind: NoteKind
  source: string
  at?: string
}

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

export interface AnswerMessage {
  id: string
  text: string
  at: string
}

export type AskAudience = 'hydra' | 'owner'

// The asking event's wording and asker never change; an escalation is its own event.
export interface Ask {
  id: string
  at: string
  actor: string
  audience: AskAudience
  kind?: 'merge'
  url?: string
  choice?: string
  closed?: {
    id: string
    at: string
    reason: string
    evidence: string
  }
  question: string
  context?: string
  details?: string
  options?: Question['options']
  // 1-based, into options.
  recommended?: number
  escalated?: {
    id: string
    at: string
    actor: string
    reason?: string
    question?: string
    context?: string
  }
  answered?: string
  answeredAt?: string
  fromMessage?: AnswerMessage
}

// An investigation's answer is its stored report; a build task's is its landed work.
export const TASK_KINDS = [
  'build',
  'investigation',
] as const
export type TaskKind = (typeof TASK_KINDS)[number]

// The text stays in the log, on the task.report event this names.
export interface TaskReport {
  id: string
  at: string
  actor: string
  chars: number
}

export interface TaskReminder {
  id: string
  at: string
  dueAt?: string
}

export interface OwnerAsk {
  text: string
  at: string
  actor: string
  message?: string
}

export interface Card {
  id: string
  key: string
  title: string
  ask?: OwnerAsk[]
  // Derived transcript totals sent to the browser; never used as Hydra state.
  spend?: TaskSpend
  brief?: string
  initialPrompt?: string
  project?: string
  kind?: TaskKind
  report?: TaskReport
  // A rule the owner chose for this task only, over its project's.
  landing?: LandingRule
  reminder?: TaskReminder
  doneAt?: string
  keepDone?: boolean
  doneAfterHours?: number
  expired?: boolean
  // Set once a push gives an explicit title; an auto title never replaces it.
  titleSet?: boolean
  autoTitle?: AutoTitle
  workspace: string
  tags: string[]
  parentId?: string
  activity?: string
  // The hook session's own latest activity, which a task source's status line does not replace.
  sessionActivity?: string
  // When the session's current turn began, while it is working.
  workingSince?: string
  // The change that ended the session's last working turn.
  turnEndedSeq?: number
  stoppedAt?: string
  agent?: AgentRef
  launch?: AgentLaunch
  // Task membership is a list for future compatibility; v1 permits at most one.
  sessionIds?: string[]
  queue?: TaskQueue
  queueNote?: string
  // Session-only records remain addressable in History, outside the live Hydra.
  hidden?: boolean
  automaticTask?: boolean
  tracking?: 'declared'
  status?: TaskDeclaration
  statusLog?: TaskDeclaration[]
  mirror?: FirstmateRecord
  settings?: AgentSettings
  terminal?: TerminalFacts
  copy?: TaskCopy
  // The working folder a source assigned, such as a Firstmate task's worktree; a
  // hook session started in it joins this card.
  folder?: string
  attention: Attention[]
  permissions?: PermissionRequest[]
  asks?: Ask[]
  links: Link[]
  sourceRefs: SourceRef[]
  outcome?: Outcome
  replies?: Reply[]
  notes?: NoteRef[]
  // The column and the position in it are set only by creation and explicit moves.
  // A lower rank sorts first; a card never moved ranks by its createdSeq.
  column: Column
  rank?: number
  revision: number
  createdSeq: number
  createdAt?: string
  updatedSeq: number
  updatedAt: string
}

export interface PushFields {
  // null, written only by undo, returns the card to its auto title.
  title?: string | null
  autoTitle?: AutoTitle
  project?: string | null
  workspace?: string
  tags?: string[]
  parentId?: string | null
  activity?: string | null
  agent?: AgentRef
  settings?: AgentSettings | null
  terminal?: TerminalFacts
  folder?: string | null
  attention?: Attention[]
}

interface EventBase {
  labelColors?: SavedLabelColor[]
  v: typeof EVENT_VERSION
  seq: number
  id: string
  at: string
  actor: string
  cardId: string
  reason?: string
  details?: string
  undoes?: string
  boardId?: string
  taskId?: string
  subtaskId?: string
  agentId?: string
  sessionId?: string
  commandId?: string
  messageId?: string
}

export const TASK_STATES = [
  'working',
  'needs_you',
  'paused',
  'blocked',
  'done',
] as const
export type TaskStatus = (typeof TASK_STATES)[number]
export interface TaskDeclaration {
  id: string
  at: string
  actor: string
  state: TaskStatus
  note: string
  // A paused worker's declared end of its wait, as an ISO time.
  until?: string
  // A pause the owner or Hydra asked for: it waits for their word, never for a timer.
  hold?: boolean
  source?: string
  raw?: string
  waitingFor?: string[]
  restores?: string
}
export interface FirstmateRecord {
  home: string
  task: string
  backlog?: Record<string, unknown>
  meta: Record<string, string>
  status: string
  present?: {
    meta: boolean
    status: boolean
  }
}
export interface HydraIdentity {
  agent?: AgentConfig
  id: string
  kind: 'agent' | 'firstmate'
  name: string
  session?: string
  home?: string
}
export interface HydraColumn {
  id: Column
  title: string
  description?: string
  // Roles survive a rename. A task created in a role's column starts with its status,
  // and a card whose column is deleted falls back to the parked one.
  role?: (typeof COLUMNS)[number] | typeof LEGACY_IN_PROGRESS
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

export interface HydraProject {
  path: string
  name: string
  detached: boolean
  landing?: Landing
  merge?: Merger
  startCommand?: {
    name: string
    command: string
    bringsOwnFolder: boolean
  }
  // A shell command run in the project folder that makes a task's copy and prints its path.
  copy?: string
}

// A task's own copy of its project: a git worktree Pnyx made, or the folder the
// project's copy command printed. It is removed only once its work has landed.
export interface TaskQueue {
  session: string
  rank: number
}

export interface TaskCopy {
  path: string
  project: string
  via: 'worktree' | 'command'
  branch?: string
  base?: string
  state: 'active' | 'flagged' | 'removed'
  reason?: string
}

export interface HydraConfig {
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
export type HydraChange = EventBase & (
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

// before holds the earlier value of each field the push changed (null when it was
// absent), so a manual edit can be undone. A push that created the card has none.
export type PushedEvent = EventBase & {
  type: 'card.pushed'
  data: PushFields & {
    key: string
    source?: SourceRef
    before?: PushFields
  }
}
// rank places the card in its new column; beforeRank keeps the old one for undo.
// A null column comes only from older logs and leaves the column as it is.
export type MovedEvent = EventBase & {
  type: 'card.moved'
  data: {
    before: Column | null
    after: Column | null
    rank?: number
    beforeRank?: number
  }
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

// One receipt of a reply sent through a source's route. The queued event carries
// the literal text; later receipts of the same reply carry only the outcome.
export type RepliedEvent = EventBase & {
  type: 'card.replied'
  data: {
    reply: string
    state: ReplyState
    route: string
    text?: string
    context?: string
    resolveKey?: string
    decision?: {
      questionId?: string
      fromMessage?: AnswerMessage
      question: string
      answer: string
      choice?: string
    }
    answers?: string
    detail?: string
    control?: boolean
    taskMessage?: boolean
    resumes?: boolean
  }
}

export interface ViewPreferences {
  focusMode: boolean
  lastMessageOnCards: boolean
  defaultHydraWidth: number
  defaultColumnWidths: Record<string, number>
  theme: 'light' | 'dark' | 'system'
  keyboard: import('./keyboard.ts').KeyboardPreferences
  fontSize: number
  chatFontSize: number
  codeFontSize: number
  panelPlacement: 'right' | 'inline'
  panelWidth: number
  hydraWidth: number
  cardHeight: number
  cardColors: boolean
  toolDetails: boolean
  thinkingDetails: boolean
  columnWidths: Record<string, number>
  cardHeights: Record<string, number>
  closedCardHeights: Record<string, number>
  cardTraceOverrides: Record<string, {
    tools?: boolean
    thinking?: boolean
  }>
  customColumns: {
    id: `custom:${string}`
    title: string
  }[]
}

export type ViewEvent = EventBase & {
  type: 'board.view'
  // placements: cards a deleted custom column moved to the fallback column, applied atomically.
  data: {
    before: ViewPreferences
    after: ViewPreferences
    placements?: {
      cardId: string
      before: Column | null
      after: Column | null
      revision: number
    }[]
  }
}

export type NotedEvent = EventBase & {
  type: 'card.noted'
  data: Note
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

export type HydraEvent =
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
  'task.kind',
  'task.report',
  'task.landing',
]

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

export interface HydraState {
  dispatchProposals?: DispatchProposal[]
  labelColors?: SavedLabelColor[]
  projects?: HydraProject[]
  projectsRevision?: number
  config?: HydraConfig
  // Set once a board.configured event applies; a column edit alone does not configure Hydra.
  configured?: boolean
  configRevision?: number
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

export const LABEL_COLORS = [
  'slate',
  'blue',
  'gold',
  'violet',
  'green',
  'rose',
  'teal',
  'coral',
] as const
export type LabelColor = (typeof LABEL_COLORS)[number]
export interface SavedLabelColor {
  label: string
  color: LabelColor
}

export class HydraError extends Error {
  code: string
  help: string[]
  constructor({
    message,
    code,
    help = [],
  }: {
    message: string
    code: string
    help?: string[]
  }) {
    super(message)
    this.code = code
    this.help = help
  }
}
