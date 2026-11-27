import type { LandingRule, Link, Outcome } from '#tasks/delivery/model.ts'
import type { Question, AgentRef, AgentLaunch, TaskQueue, AgentSettings, TerminalFacts, Attention, PermissionRequest, Reply, SteeringMessage, ReplyState, CardWorkerInput } from '#workers/model.ts'
import type { ProjectRefresh } from '#projects/refresh-types.ts'
import type { TaskSpend } from '#workers/task-spend.ts'
import type { TaskCopy } from '#projects/model.ts'
import type { SourceRef } from '#app/model.ts'
import type { ExternalSource } from '#task-sources/model.ts'
import type { EventBase } from '#store/events.ts'

export const MAX_BRIEF_LENGTH = 24000

export const NOTE_KINDS = [
  'summary',
  'decision',
  'context',
] as const

type NoteKind = (typeof NOTE_KINDS)[number]

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
  operation?: string
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

interface NoteRef {
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

export type AskAudience = 'titan' | 'owner'

// The asking event's wording and asker never change; an escalation is its own event.
export interface Ask {
  id: string
  at: string
  actor: string
  audience: AskAudience

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
  mergeHold?: Pick<Ask, 'answered' | 'answeredAt' | 'fromMessage' | 'choice'>
  reaskedAt?: string
  answerRound?: string
  deferredUntil?: string
  deferredFromMessage?: AnswerMessage
}

export interface TaskReminder {
  id: string
  at: string
  dueAt?: string
  repeat?: ReminderRepeat
  dueEvent?: string
}

export interface ReminderRepeat {
  everyMs: number
  until: 'worker-started' | 'question-answered' | 'task-done'
  question?: string
}

export interface OwnerAsk {
  text: string
  at: string
  actor: string
  message?: string
}

interface TaskHold {
  id: string
  at: string
  actor: string
  reason: string
}

interface CardFacts {
  childWorking: boolean
  waitTitle?: string
  unmetPrerequisites: ReturnType<typeof import('./dependencies.ts').unmetPrerequisites>
  // Each linked pull request's deciding merge question, among every card's.
  mergeQuestions: Record<string, {
    // The question's card when it is another one.
    card?: Card
    ask: Ask
  } | undefined>
}

export type WorkerCode = 'needs-you' | 'blocked' | 'done' | 'link' | 'note' | 'invalid'

export interface WorkerLine {
  identity: string
  off: number
  gen: number
  tail: string
  discarding?: true
  code: WorkerCode
  text: string
  at: string
}

interface WorkerLog {
  latest: WorkerLine
  status?: WorkerLine
}

export interface Card {
  notices?: import('#app/command-notices.ts').CommandNotice[]
  branches?: {
    repository: string
    branch: string
  }[]
  workerLogDir?: string
  workerLog?: WorkerLog
  tools?: string[]
  toolsRevision?: string
  toolsApplied?: string
  wait?: TaskWait & {
    id: string
    at: string
  }
  compaction?: import('#workers/compaction/model.ts').CompactionState
  projectRefresh?: Record<string, ProjectRefresh>
  prerequisites?: string[]
  hold?: TaskHold
  unstarted?: string
  id: string
  key: string
  title: string
  ask?: OwnerAsk[]
  // Derived transcript totals sent to the browser; never used as Titan state.
  spend?: TaskSpend
  usage?: import('#workers/provider.ts').AgentUsage
  // Facts that read other cards, which the server derives for the page; never used as Titan state.
  facts?: CardFacts
  brief?: string
  // The card's Intent: what the owner wants from the task, newest version.
  intent?: string
  initialPrompt?: string
  project?: string
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
  hidden?: boolean
  settings?: AgentSettings
  terminal?: TerminalFacts
  copy?: TaskCopy
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
  // A lower rank sorts first; a card never moved ranks by its createdSeq.
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
  rank?: number | null
  activity?: string | null
  agent?: AgentRef
  settings?: AgentSettings | null
  terminal?: TerminalFacts
  folder?: string | null
  attention?: Attention[]
}

export type TaskStatus = 'working' | 'needs_you' | 'paused' | 'blocked' | 'done'

export interface TaskWait {
  task: string
  condition: 'task-done' | 'pr-opened' | 'pr-merged'
}

// before holds the earlier value of each field the push changed (null when it was
// absent), so a manual edit can be undone. A push that created the card has none.
export type PushedEvent = EventBase & {
  type: 'task.edited'
  data: PushFields & {
    key: string
    source?: SourceRef
    before?: PushFields
  }
}

// Legacy repeat records remain replayable; new repeats advance a private observation time.
export type ObservedEvent = EventBase & {
  type: 'card.observed'
  data: {
    source: SourceRef
    of: string
  }
}

// One receipt of a reply sent through a source's route. The queued event carries
// the literal text; later receipts of the same reply carry only the outcome.
export type RepliedEvent = EventBase & {
  type: 'card.replied'
  data: {
    reply: string
    worker?: CardWorkerInput
    state: ReplyState
    route: string
    text?: string
    context?: string
    decision?: {
      questionId?: string
      fromMessage?: AnswerMessage
      question: string
      answer: string
      choice?: string
      liftsHold?: string
      answerRound?: string
    }
    answers?: string
    accepted?: boolean
    detail?: string
    control?: boolean
    taskMessage?: boolean
    resumes?: boolean
    // When the agent's harness took the message, not only when Othrys handed it over.
    received?: string
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

type LabelColor = (typeof LABEL_COLORS)[number]

export interface SavedLabelColor {
  label: string
  color: LabelColor
}
