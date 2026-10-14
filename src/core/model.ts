// Event schema and board model. Version 1 of the log format.

export const EVENT_VERSION = 1 as const

export const COLUMNS = ['needs_you', 'workers_on_it', 'review', 'done'] as const
export type Column = (typeof COLUMNS)[number] | `custom:${string}`

export const LINK_KINDS = ['github_pr', 'linear', 'url'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export const LINK_STATES = ['open', 'merged', 'closed'] as const
export type LinkState = (typeof LINK_STATES)[number]

export const OUTCOME_STATES = ['done', 'failed', 'cancelled'] as const
export type OutcomeState = (typeof OUTCOME_STATES)[number]

// queued: recorded before the send. delivery_unknown: the route could not confirm
// the send either way, so it is never resent blindly.
export const REPLY_STATES = ['queued', 'delivered', 'delivery_unknown', 'failed'] as const
export type ReplyState = (typeof REPLY_STATES)[number]

// What a harvested note records: a summary of the work, a decision with its
// question and answer, or context such as a session title or a brief's intent.
export const NOTE_KINDS = ['summary', 'decision', 'context'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

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
// Paseo terminal, Herdr pane or iTerm2 session around it. A reply route reads it.
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

// An explicit source request. blocking requests (a question, a permission prompt)
// outrank linked pull requests; the rest only outrank ongoing work.
export interface Attention {
  kind: string
  key: string
  blocking: boolean
  text?: string
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
  workspace: string
  tags: string[]
  parentId?: string
  activity?: string
  agent?: AgentRef
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
  title?: string
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
}

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
    detail?: string
  }
}

export interface ViewPreferences {
  keyboard: import('./keyboard.ts').KeyboardPreferences
  fontSize: number
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
  data: { before: ViewPreferences; after: ViewPreferences }
}

// One harvested note. Its id is derived from the source record, so harvesting the
// same record again appends nothing.
export type NotedEvent = EventBase & { type: 'card.noted'; data: Note }

export type BoardEvent =
  | PushedEvent
  | MovedEvent
  | LinkedEvent
  | OutcomeEvent
  | RepliedEvent
  | NotedEvent
  | ViewEvent
export type EventType = BoardEvent['type']
export const EVENT_TYPES: readonly EventType[] = ['card.pushed', 'card.moved', 'card.linked', 'card.outcome', 'card.replied', 'card.noted', 'board.view']

export interface BoardState {
  view?: ViewPreferences
  viewRevision?: number
  v: typeof EVENT_VERSION
  seq: number
  cards: Record<string, Card>
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
  constructor(message: string, code: string, help: string[] = []) {
    super(message)
    this.code = code
    this.help = help
  }
}
