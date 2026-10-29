import type { LandingRule, Link, Outcome } from '#tasks/delivery/model.ts'
import type { Question, AgentRef, AgentLaunch, TaskQueue, AgentSettings, TerminalFacts, Attention, PermissionRequest, Reply, SteeringMessage, ReplyState } from '#workers/model.ts'
import type { ProjectRefresh } from '#projects/refresh-types.ts'
import type { TaskSpend } from '#workers/task-spend.ts'
import type { TaskReport } from '#investigations/model.ts'
import type { FirstmateRecord } from '#integrations/firstmate/model.ts'
import type { TaskCopy } from '#projects/model.ts'
import type { SourceRef } from '#app/model.ts'
import type { ExternalSource } from '#task-sources/model.ts'
import type { Column } from './columns-model.ts'
import type { EventBase } from '#store/events.ts'

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
  origin?: {
    task: string
    report: string
  }
  kind?: 'merge' | 'go'
  hold?: TaskHold
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

export interface TaskProgress {
  text: string
  at: string
  actor: string
}

export interface TaskHold {
  id: string
  at: string
  actor: string
  reason: string
}

export interface Card {
  compaction?: import('#workers/compaction/model.ts').CompactionState
  projectRefresh?: Record<string, ProjectRefresh>
  prerequisites?: string[]
  hold?: TaskHold
  id: string
  key: string
  title: string
  ask?: OwnerAsk[]
  // Derived transcript totals sent to the browser; never used as Hydra state.
  spend?: TaskSpend
  brief?: string
  // The card's Intent: what the owner wants from the task, newest version.
  intent?: string
  // The worker's newest progress report; the newer of it and the newest status note is the card's Current state.
  progress?: TaskProgress
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
  // When the session's latest working turn began; kept after the turn ends.
  turnStartedAt?: string
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
  steering?: SteeringMessage[]
  steeringGeneration?: number
  externalSources?: ExternalSource[]
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

export type NotedEvent = EventBase & {
  type: 'card.noted'
  data: Note
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
