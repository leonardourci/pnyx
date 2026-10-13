// Turns a requested change into the event to append, validated against the current
// board. Pure: the caller supplies the time and actor.
import { isDeepStrictEqual } from "node:util";
import {
  BoardError,
  EVENT_VERSION,
  LINK_KINDS,
  LINK_STATES,
  type Attention,
  type BoardEvent,
  type BoardState,
  type Card,
  type Column,
  type Link,
  type Outcome,
  type PushFields,
  type SourceRef,
} from "./model.ts";
import { isStaleLink, isStaleSource, reduce, wouldCycle } from "./reducer.ts";

export interface Meta {
  at: string;
  actor: string;
  // Caller-chosen event id; repeating it is a no-op.
  id?: string;
  reason?: string;
}

export type Decision = { event: BoardEvent } | { skipped: "unchanged" | "stale" | "duplicate" };

export function findCard(state: BoardState, ref: string): Card {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? ""];
  if (!card) throw new BoardError(`card not found: ${ref}`, "NOT_FOUND", ["Run `pnyx-axi` to list cards"]);
  return card;
}

function base(state: BoardState, meta: Meta, cardId: string) {
  const seq = state.seq + 1;
  return {
    v: EVENT_VERSION,
    seq,
    id: meta.id ?? `evt_${seq}`,
    at: meta.at,
    actor: meta.actor,
    cardId,
    ...(meta.reason ? { reason: meta.reason } : {}),
  };
}

function strip(card: Card | undefined) {
  if (!card) return undefined;
  const content: Partial<Card> = { ...card };
  delete content.revision;
  delete content.updatedSeq;
  delete content.updatedAt;
  return content;
}

function decided(state: BoardState, meta: Meta, event: BoardEvent): Decision {
  if (meta.id !== undefined && meta.id in state.eventIds) return { skipped: "duplicate" };
  const before = strip(state.cards[event.cardId]);
  const after = strip(reduce(state, event).cards[event.cardId]);
  return before && isDeepStrictEqual(before, after) ? { skipped: "unchanged" } : { event };
}

function checkRevision(card: Card, ifRevision: number | undefined): void {
  if (ifRevision !== undefined && card.revision !== ifRevision) {
    throw new BoardError(`card ${card.id} is at revision ${card.revision}, not ${ifRevision}`, "CONFLICT", [
      `Run \`pnyx-axi card ${card.id}\` and retry with the current revision`,
    ]);
  }
}

function invalid(message: string): BoardError {
  return new BoardError(message, "VALIDATION_ERROR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw invalid(`${what}: unknown field ${extra.join(", ")}; allowed: ${allowed.join(", ")}`);
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`${what} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : text(value, what);
}

function parseAttention(value: unknown): Attention[] {
  if (!Array.isArray(value)) throw invalid("attention must be a list");
  return value.map((item, i) => {
    if (!isRecord(item)) throw invalid(`attention[${i}] must be an object`);
    onlyKeys(item, ["kind", "key", "blocking", "text"], `attention[${i}]`);
    if (item.blocking !== undefined && typeof item.blocking !== "boolean") {
      throw invalid(`attention[${i}].blocking must be true or false`);
    }
    const note = optionalText(item.text, `attention[${i}].text`);
    return {
      kind: text(item.kind, `attention[${i}].kind`),
      key: text(item.key, `attention[${i}].key`),
      blocking: item.blocking === true,
      ...(note ? { text: note } : {}),
    };
  });
}

function parseSource(value: unknown): SourceRef {
  if (!isRecord(value)) throw invalid("source must be an object");
  onlyKeys(value, ["adapter", "instanceId", "objectId", "generation", "cursor", "observedAt"], "source");
  const { generation } = value;
  if (generation !== undefined && !(Number.isInteger(generation) && (generation as number) >= 0)) {
    throw invalid("source.generation must be a non-negative integer");
  }
  const source: SourceRef = { adapter: text(value.adapter, "source.adapter"), objectId: text(value.objectId, "source.objectId") };
  const instanceId = optionalText(value.instanceId, "source.instanceId");
  const cursor = optionalText(value.cursor, "source.cursor");
  const observedAt = optionalText(value.observedAt, "source.observedAt");
  if (instanceId) source.instanceId = instanceId;
  if (generation !== undefined) source.generation = generation as number;
  if (cursor) source.cursor = cursor;
  if (observedAt) source.observedAt = observedAt;
  return source;
}

// Upserts the card with this key. `input` is the untrusted card JSON; `parent`
// names the parent card by id or key, and null clears it.
export function decidePush(state: BoardState, key: string, input: unknown, meta: Meta): Decision {
  text(key, "key");
  if (!isRecord(input)) throw invalid("card must be a JSON object");
  onlyKeys(input, ["title", "workspace", "tags", "parent", "activity", "attention", "source"], "card");

  const cardId = state.keys[key] ?? `c${state.seq + 1}`;
  const fields: PushFields = {};
  const title = optionalText(input.title, "title");
  const workspace = optionalText(input.workspace, "workspace");
  const activity = optionalText(input.activity, "activity");
  if (title) fields.title = title;
  if (workspace) fields.workspace = workspace;
  if (activity) fields.activity = activity;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) throw invalid("tags must be a list of strings");
    fields.tags = [...new Set(input.tags.map((t, i) => text(t, `tags[${i}]`)))];
  }
  if (input.attention !== undefined) fields.attention = parseAttention(input.attention);
  if (input.parent === null) {
    fields.parentId = null;
  } else if (input.parent !== undefined) {
    const parent = findCard(state, text(input.parent, "parent"));
    if (wouldCycle(state.cards, cardId, parent.id)) throw invalid(`parent ${parent.id} would make a cycle`);
    fields.parentId = parent.id;
  }
  const source = input.source === undefined ? undefined : parseSource(input.source);
  if (source && isStaleSource(state.cards[cardId], source)) return { skipped: "stale" };

  return decided(state, meta, {
    ...base(state, meta, cardId),
    type: "card.pushed",
    data: { key, ...fields, ...(source ? { source } : {}) },
  });
}

// column null returns the card to automatic placement.
export function decideMove(
  state: BoardState,
  ref: string,
  column: Column | null,
  meta: Meta,
  ifRevision?: number,
): Decision {
  const card = findCard(state, ref);
  checkRevision(card, ifRevision);
  return decided(state, meta, {
    ...base(state, meta, card.id),
    type: "card.moved",
    data: { before: card.manualColumn ?? null, after: column },
  });
}

// Builds a link from CLI-style input, filling kind and number from a GitHub pull
// request URL when they are not given.
export function parseLink(input: { url: string; kind?: string; number?: string; title?: string; state?: string; checkedAt?: string }): Link {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw invalid(`not a URL: ${input.url}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("link URL must be http or https");
  const pr = /^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(url.pathname);
  const isGitHubPr = url.hostname === "github.com" && pr !== null;
  const kind = input.kind ?? (isGitHubPr ? "github_pr" : "url");
  if (!(LINK_KINDS as readonly string[]).includes(kind)) throw invalid(`kind must be one of ${LINK_KINDS.join(", ")}`);
  if (input.state !== undefined && !(LINK_STATES as readonly string[]).includes(input.state)) {
    throw invalid(`state must be one of ${LINK_STATES.join(", ")}`);
  }
  const number = input.number ?? (isGitHubPr ? pr[1] : undefined);
  if (number !== undefined && !/^\d+$/.test(number)) throw invalid("number must be a positive integer");
  const link: Link = { kind: kind as Link["kind"], url: input.url };
  if (number !== undefined) link.number = Number(number);
  if (input.title) link.title = input.title;
  if (input.state) link.state = input.state as Link["state"];
  if (input.checkedAt) link.checkedAt = input.checkedAt;
  return link;
}

// Adds or updates a link (merged over the existing one with the same URL), or
// removes it when link is null.
export function decideLink(state: BoardState, ref: string, url: string, link: Link | null, meta: Meta): Decision {
  const card = findCard(state, ref);
  const current = card.links.find((l) => l.url === url);
  if (!link && !current) return { skipped: "unchanged" };
  const after = link ? { ...current, ...link } : null;
  if (after && isStaleLink(current, after)) return { skipped: "stale" };
  return decided(state, meta, {
    ...base(state, meta, card.id),
    type: "card.linked",
    data: { url, before: current ?? null, after },
  });
}

export function decideOutcome(state: BoardState, ref: string, outcome: Outcome | null, meta: Meta): Decision {
  const card = findCard(state, ref);
  return decided(state, meta, {
    ...base(state, meta, card.id),
    type: "card.outcome",
    data: {
      before: card.outcome ?? null,
      after: outcome,
      card: { title: card.title, workspace: card.workspace, tags: card.tags, links: card.links },
    },
  });
}

function currentValue(card: Card, target: BoardEvent): unknown {
  if (target.type === "card.moved") return card.manualColumn ?? null;
  if (target.type === "card.linked") return card.links.find((l) => l.url === target.data.url) ?? null;
  return card.outcome ?? null;
}

// Appends the reverse of `target`. Refuses when the field has changed since, so an
// undo never silently overwrites a later edit.
export function decideUndo(state: BoardState, target: BoardEvent, meta: Meta, ifRevision?: number): Decision {
  if (target.type === "card.pushed") {
    throw invalid(`${target.type} cannot be undone; only moves, links and outcomes can`);
  }
  const by = state.undone[target.id];
  if (by) {
    throw new BoardError(`${target.id} was already undone by ${by}`, "CONFLICT", [`Run \`pnyx-axi undo ${by}\` to redo it`]);
  }
  const card = findCard(state, target.cardId);
  checkRevision(card, ifRevision);
  if (!isDeepStrictEqual(currentValue(card, target), target.data.after)) {
    throw new BoardError(`${target.id} no longer matches card ${card.id}: it changed since`, "CONFLICT", [
      `Run \`pnyx-axi history --card ${card.id}\` to see the later change`,
    ]);
  }
  const head = { ...base(state, meta, card.id), undoes: target.id };
  if (target.type === "card.moved") {
    return decided(state, meta, { ...head, type: "card.moved", data: { before: target.data.after, after: target.data.before } });
  }
  if (target.type === "card.linked") {
    const data = { url: target.data.url, before: target.data.after, after: target.data.before };
    return decided(state, meta, { ...head, type: "card.linked", data });
  }
  return decided(state, meta, {
    ...head,
    type: "card.outcome",
    data: {
      before: target.data.after,
      after: target.data.before,
      card: { title: card.title, workspace: card.workspace, tags: card.tags, links: card.links },
    },
  });
}
