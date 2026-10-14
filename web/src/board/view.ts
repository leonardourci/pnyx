import type { BoardState, Card, Column, Link } from "../../../src/core/model.ts";
import { viewFor } from "../../../src/core/view.ts";
export const BUILTIN_COLUMNS: { id: Column; title: string; description: string }[] = [
  { id: "needs_you", title: "Needs you", description: "Decisions & interruptions" },
  { id: "workers_on_it", title: "Workers on it", description: "Open work, including idle agents" },
  { id: "review", title: "Review", description: "Linked change is open" },
  { id: "done", title: "Done", description: "Confirmed outcomes & merges" },
];
export const columnsFor = (state: BoardState) => [...BUILTIN_COLUMNS, ...viewFor(state).customColumns.map(c => ({ ...c, description: "Manual placement" }))];
export function filterCards(state: BoardState, workspace: string, tag: string, query = ""): Card[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return Object.values(state.cards).filter(c => (!workspace || c.workspace === workspace) && (!tag || c.tags.includes(tag)) && words.every(w => [c.title, c.key, ...c.tags, ...c.links.map(l => `${l.number ?? ""} ${l.title ?? ""}`)].join(" ").toLowerCase().includes(w))).sort((a,b) => b.updatedSeq - a.updatedSeq || a.id.localeCompare(b.id));
}
export function visibleParent(card: Card, visible: Card[]): Card | undefined { return visible.find(c => c.id === card.parentId); }
export function safeLink(link: Link): string | undefined { try { const url = new URL(link.url); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } }
export const receiptLabel = (state: string) => ({ queued: "Queued", delivered: "Delivered", delivery_unknown: "Delivery unknown", failed: "Delivery failed" }[state] ?? state);
export const slashPrefix = (text: string, cursor: number) => /^\/[a-z-]*$/i.test(text.slice(0, cursor)) ? text.slice(0, cursor).toLowerCase() : null;
