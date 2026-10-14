// Event schema and board model. Version 1 of the log format.

export const EVENT_VERSION = 1 as const;

export const COLUMNS = ["needs_you", "workers_on_it", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export const LINK_KINDS = ["github_pr", "linear", "url"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_STATES = ["open", "merged", "closed"] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const OUTCOME_STATES = ["done", "failed", "cancelled"] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

// queued: recorded before the send. delivery_unknown: the route could not confirm
// the send either way, so it is never resent blindly.
export const REPLY_STATES = ["queued", "delivered", "delivery_unknown", "failed"] as const;
export type ReplyState = (typeof REPLY_STATES)[number];

// Where an observation came from. generation and observedAt order observations of
// the same source object so a late, older observation cannot overwrite a newer one.
export interface SourceRef {
  adapter: string;
  instanceId?: string;
  objectId: string;
  generation?: number;
  cursor?: string;
  observedAt?: string;
}

// The harness session behind a card: a hook-reported session or one of its subagents.
export interface AgentRef {
  provider: string;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  cwd?: string;
  transcriptPath?: string;
}

export interface Link {
  kind: LinkKind;
  url: string;
  number?: number;
  title?: string;
  state?: LinkState;
  checkedAt?: string;
}

// An explicit source request. blocking requests (a question, a permission prompt)
// outrank linked pull requests; the rest only outrank ongoing work.
export interface Attention {
  kind: string;
  key: string;
  blocking: boolean;
  text?: string;
}

// closed: the source closed the task, so even a failure is final and needs no one.
// source: the adapter that observed the outcome; only that source may change it.
export interface Outcome {
  state: OutcomeState;
  note?: string;
  closed?: boolean;
  source?: string;
}

// A reply's latest receipt. The text stays in the log, on its queued event.
export interface Reply {
  id: string;
  state: ReplyState;
}

export interface Card {
  id: string;
  key: string;
  title: string;
  workspace: string;
  tags: string[];
  parentId?: string;
  activity?: string;
  agent?: AgentRef;
  attention: Attention[];
  links: Link[];
  sourceRefs: SourceRef[];
  outcome?: Outcome;
  replies?: Reply[];
  // Set by a manual move and kept until `move --auto`.
  manualColumn?: Column;
  column: Column;
  revision: number;
  createdSeq: number;
  updatedSeq: number;
  updatedAt: string;
}

// Fields a push may set. Omitted fields keep their current value.
export interface PushFields {
  title?: string;
  workspace?: string;
  tags?: string[];
  parentId?: string | null;
  activity?: string | null;
  agent?: AgentRef;
  attention?: Attention[];
}

interface EventBase {
  v: typeof EVENT_VERSION;
  seq: number;
  id: string;
  at: string;
  actor: string;
  cardId: string;
  reason?: string;
  // Set on an event that reverses an earlier one.
  undoes?: string;
}

// before holds the earlier value of each field the push changed (null when it was
// absent), so a manual edit can be undone. A push that created the card has none.
export type PushedEvent = EventBase & {
  type: "card.pushed";
  data: PushFields & { key: string; source?: SourceRef; before?: PushFields };
};
export type MovedEvent = EventBase & {
  type: "card.moved";
  data: { before: Column | null; after: Column | null };
};
export type LinkedEvent = EventBase & {
  type: "card.linked";
  data: { url: string; before: Link | null; after: Link | null };
};
// Keeps the card's title, workspace, tags and links as they were when the outcome
// was recorded, so history stays readable after later edits.
export type OutcomeEvent = EventBase & {
  type: "card.outcome";
  data: {
    before: Outcome | null;
    after: Outcome | null;
    card: { title: string; workspace: string; tags: string[]; links: Link[] };
  };
};

// One receipt of a reply sent through a source's route. The queued event carries
// the literal text; later receipts of the same reply carry only the outcome.
export type RepliedEvent = EventBase & {
  type: "card.replied";
  data: { reply: string; state: ReplyState; route: string; text?: string; resolveKey?: string; detail?: string };
};

export type BoardEvent = PushedEvent | MovedEvent | LinkedEvent | OutcomeEvent | RepliedEvent;
export type EventType = BoardEvent["type"];
export const EVENT_TYPES: readonly EventType[] = ["card.pushed", "card.moved", "card.linked", "card.outcome", "card.replied"];

export interface BoardState {
  v: typeof EVENT_VERSION;
  seq: number;
  cards: Record<string, Card>;
  // card key -> card id
  keys: Record<string, string>;
  // event id -> seq, so a retried or respooled event is applied once.
  // ponytail: grows with the log; move to a per-segment index if snapshots get large.
  eventIds: Record<string, number>;
  // undone event id -> id of the event that reversed it
  undone: Record<string, string>;
}

export class BoardError extends Error {
  code: string;
  help: string[];
  constructor(message: string, code: string, help: string[] = []) {
    super(message);
    this.code = code;
    this.help = help;
  }
}
