// Event schema and board model. Version 1 of the log format.

export const EVENT_VERSION = 1 as const

export const COLUMNS = ['needs_you', 'workers_on_it', 'review', 'done', 'parked'] as const
export type Column = (typeof COLUMNS)[number] | `custom:${string}`

export const LINK_KINDS = ['github_pr', 'linear', 'url'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export const LINK_STATES = ['open', 'merged', 'closed'] as const
export type LinkState = (typeof LINK_STATES)[number]

// The outcomes a person or agent records. "ended" is observed only: a harness
// reporting its session closed.
export const OUTCOME_STATES = ['done', 'failed', 'cancelled'] as const
export type OutcomeState = (typeof OUTCOME_STATES)[number] | 'ended'

// queued: recorded before the send. delivery_unknown: the route could not confirm
// the send either way, so it is never resent blindly.
export const REPLY_STATES = ['queued', 'delivered', 'delivery_unknown', 'failed'] as const
export type ReplyState = (typeof REPLY_STATES)[number]

// What a harvested note records: a summary of the work, a decision with its
// question and answer, or context such as a session title or a brief's intent.
export const NOTE_KINDS = ['summary', 'decision', 'context'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

// How a harvested context note names the harness's own session title.
export const SESSION_TITLE = 'Session title: '

// A title a source offers for a card nobody titled, best first: the harness's own
// session title, the session's first prompt, a subagent's type and short id, then
// its working folder.
export const AUTO_TITLE_SOURCES = ['session', 'prompt', 'agent', 'folder'] as const

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

// The harness session behind a card: a hook-reported session or one of its subagents.
export interface AgentRef {
  provider: string
  sessionId: string
  agentId?: string
  agentType?: string
  cwd?: string
  transcriptPath?: string
}

// A harness session's settings as the harness itself recorded them, by name: model,
// effort, mode and fast, plus any setting only one harness has. Only known values
// are kept. src/integrations/hooks/settings.ts lists where each one comes from.
export type AgentSettings = Record<string, string>

// Where a hook found the session's terminal, recorded from the environment it ran
// in: the harness process and its TTY, the terminal program, and the tmux pane,
// Paseo terminal or Herdr pane around it. A reply route reads it.
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
}

// One question an agent put with the options its own prompt shows, as Claude Code's
// AskUserQuestion sends it. multiSelect takes several options instead of one.
export interface Question {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

export const FORM_FIELD_TYPES = ['string', 'number', 'integer', 'boolean'] as const

// One field of an MCP server's form, as its elicitation schema names it. options
// lists the values of a choice field.
export interface FormField {
  name: string
  title?: string
  type: (typeof FORM_FIELD_TYPES)[number]
  options?: string[]
  required?: boolean
}

// An explicit source request. blocking requests (a question, a permission prompt)
// outrank linked pull requests; the rest only outrank ongoing work.
export interface Attention {
  kind: string
  key: string
  blocking: boolean
  text?: string
  // The questions behind a question request, so the board can answer it inline.
  questions?: Question[]
  // The fields of an MCP server's form, so the board can fill it in inline.
  form?: FormField[]
  // The reply that answered it from the board. The request stays until the session's
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
}

// A note a source already recorded, harvested as it was written: never generated.
// source names where it came from, such as claude-code, codex, firstmate or github.
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

// A note on the card. The text stays in the log, on its noted event.
export interface NoteRef {
  id: string
  kind: NoteKind
  source: string
  at?: string
}

export interface Card {
  id: string
  key: string
  title: string
  // Set once a push gives an explicit title; an auto title never replaces it.
  titleSet?: boolean
  autoTitle?: AutoTitle
  workspace: string
  tags: string[]
  parentId?: string
  activity?: string
  // The hook session's own latest activity, which a task source's status line does not replace.
  sessionActivity?: string
  agent?: AgentRef
  // Task membership is a list for future compatibility; v1 permits at most one.
  sessionIds?: string[]
  // Session-only records remain addressable in History, outside the live board.
  hidden?: boolean
  automaticTask?: boolean
  tracking?: 'declared'
  status?: TaskDeclaration
  statusLog?: TaskDeclaration[]
  mirror?: FirstmateRecord
  settings?: AgentSettings
  terminal?: TerminalFacts
  // The working folder a source assigned, such as a Firstmate task's worktree; a
  // hook session started in it joins this card.
  folder?: string
  attention: Attention[]
  links: Link[]
  sourceRefs: SourceRef[]
  outcome?: Outcome
  replies?: Reply[]
  notes?: NoteRef[]
  // Set by a manual move and kept until `move --auto`.
  manualColumn?: Column
  column: Column
  revision: number
  createdSeq: number
  updatedSeq: number
  updatedAt: string
}

// Fields a push may set. Omitted fields keep their current value.
export interface PushFields {
  // null, written only by undo, returns the card to its auto title.
  title?: string | null
  autoTitle?: AutoTitle
  workspace?: string
  tags?: string[]
  parentId?: string | null
  activity?: string | null
  agent?: AgentRef
  // The card's whole settings after the push; null when it has none.
  settings?: AgentSettings | null
  terminal?: TerminalFacts
  folder?: string | null
  attention?: Attention[]
}

interface EventBase {
  v: typeof EVENT_VERSION
  seq: number
  id: string
  at: string
  actor: string
  cardId: string
  reason?: string
  // Set on an event that reverses an earlier one.
  undoes?: string
  boardId?: string
  taskId?: string
  subtaskId?: string
  agentId?: string
  sessionId?: string
  commandId?: string
  messageId?: string
}

export const TASK_STATES = ['working', 'needs_you', 'paused', 'blocked', 'done'] as const
export type TaskStatus = (typeof TASK_STATES)[number]
export interface TaskDeclaration {
  id: string
  at: string
  actor: string
  state: TaskStatus
  note: string
  source?: string
  raw?: string
}
export interface FirstmateRecord {
  home: string
  task: string
  backlog?: Record<string, unknown>
  meta: Record<string, string>
  status: string
  present?: { meta: boolean; status: boolean }
}
export interface HydraIdentity {
  id: string
  kind: 'agent' | 'firstmate'
  name: string
  session?: string
  home?: string
}
export interface BoardColumn {
  id: Column
  title: string
  // Roles survive a rename. Automatic placement uses the first matching role.
  role?: 'needs_you' | 'workers_on_it' | 'done' | 'parked'
}
export interface BoardConfig {
  id: string
  name: string
  hydra: HydraIdentity
  columns: BoardColumn[]
}
export interface HydraMessage {
  id: string
  task?: string
  action: 'send' | 'worker'
  text: string
  at: string
  actor: string
  hydra: string
}
export type HydraEvent = EventBase & (
  | { type: 'board.configured'; data: BoardConfig }
  | { type: 'board.columns'; data: { columns: BoardColumn[]; before?: BoardColumn[]; fallback?: Column; placements?: Record<string, { before: Column | null; after: Column | null }> } }
  | { type: 'task.created'; data: { key: string; title: string; parentId?: string; column?: Column; folder?: string } }
  | { type: 'task.declared'; data: Omit<TaskDeclaration, 'id' | 'at' | 'actor'> }
  | { type: 'task.mirrored'; data: FirstmateRecord }
  | { type: 'hydra.message'; data: Omit<HydraMessage, 'id' | 'at' | 'actor'> }
)

// before holds the earlier value of each field the push changed (null when it was
// absent), so a manual edit can be undone. A push that created the card has none.
export type PushedEvent = EventBase & {
  type: 'card.pushed'
  data: PushFields & { key: string; source?: SourceRef; before?: PushFields }
}
export type MovedEvent = EventBase & {
  type: 'card.moved'
  data: { before: Column | null; after: Column | null }
}
export type LinkedEvent = EventBase & {
  type: 'card.linked'
  data: { url: string; before: Link | null; after: Link | null }
}
// Keeps the card's title, workspace, tags and links as they were when the outcome
// was recorded, so history stays readable after later edits.
export type OutcomeEvent = EventBase & {
  type: 'card.outcome'
  data: {
    before: Outcome | null
    after: Outcome | null
    card: { title: string; workspace: string; tags: string[]; links: Link[] }
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
    resolveKey?: string
    // The request key an inline answer answers; its delivered receipt marks it answered.
    answers?: string
    detail?: string
  }
}

export interface ViewPreferences {
  theme: 'light' | 'dark' | 'system'
  keyboard: import('./keyboard.ts').KeyboardPreferences
  fontSize: number
  chatFontSize: number
  codeFontSize: number
  panelPlacement: 'right' | 'inline'
  panelWidth: number
  composerHeight: number
  cardHeight: number
  cardColors: boolean
  toolDetails: boolean
  thinkingDetails: boolean
  columnWidths: Record<string, number>
  cardHeights: Record<string, number>
  cardTraceOverrides: Record<string, { tools?: boolean; thinking?: boolean }>
  customColumns: { id: `custom:${string}`; title: string }[]
}

export type ViewEvent = EventBase & {
  type: 'board.view'
  // placements: cards a deleted custom column returned to automatic placement, applied atomically.
  data: {
    before: ViewPreferences
    after: ViewPreferences
    placements?: { cardId: string; before: Column | null; after: Column | null; revision: number }[]
  }
}

// One harvested note. Its id is derived from the source record, so harvesting the
// same record again appends nothing.
export type NotedEvent = EventBase & { type: 'card.noted'; data: Note }

export interface AgentSession {
  id: string
  agent: AgentRef
  originCardId: string
  taskId: string | null
  terminal?: TerminalFacts
  settings?: AgentSettings
  activity?: string
  sessionActivity?: string
  attention: Attention[]
  outcome?: Outcome
  sourceRefs: SourceRef[]
}

export type SessionEvent = EventBase & {
  type: 'task.session'
  data: { session: string; before: string | null; after: string | null }
}

export type ChatEvent = EventBase & {
  type: 'chat.message'
  data: { session: string; nativeId: string; role: string; text: string }
}

export type BoardEvent =
  | PushedEvent
  | MovedEvent
  | LinkedEvent
  | OutcomeEvent
  | RepliedEvent
  | NotedEvent
  | ViewEvent
  | SessionEvent
  | HydraEvent
  | ChatEvent
export type EventType = BoardEvent['type']
export const EVENT_TYPES: readonly EventType[] = ['card.pushed', 'card.moved', 'card.linked', 'card.outcome', 'card.replied', 'card.noted', 'board.view', 'task.session', 'board.configured', 'board.columns', 'task.created', 'task.declared', 'task.mirrored', 'hydra.message', 'chat.message']

export interface BoardState {
  board?: BoardConfig
  // Set once a board.configured event applies; a column edit alone does not configure Hydra.
  configured?: boolean
  boardRevision?: number
  hydraMessages?: HydraMessage[]
  view?: ViewPreferences
  viewRevision?: number
  v: typeof EVENT_VERSION
  seq: number
  cards: Record<string, Card>
  sessions?: Record<string, AgentSession>
  // card key -> card id
  keys: Record<string, string>
  // event id -> seq, so a retried or respooled event is applied once.
  // ponytail: grows with the log; move to a per-segment index if snapshots get large.
  eventIds: Record<string, number>
  // undone event id -> id of the event that reversed it
  undone: Record<string, string>
}

export class BoardError extends Error {
  code: string
  help: string[]
  constructor({ message, code, help = [] }: { message: string; code: string; help?: string[] }) {
    super(message)
    this.code = code
    this.help = help
  }
}
