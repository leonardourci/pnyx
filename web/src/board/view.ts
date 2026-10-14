import type { BoardState, Card, Column, Link } from '../../../src/core/model.ts'
import { viewFor } from '../../../src/core/view.ts'

export const BUILTIN_COLUMNS: { id: Column; title: string; description: string }[] = [
  { id: 'needs_you', title: 'Needs you', description: 'Decisions & interruptions' },
  { id: 'workers_on_it', title: 'Workers on it', description: 'Open work, including idle agents' },
  { id: 'review', title: 'Review', description: 'Linked change is open' },
  { id: 'done', title: 'Done', description: 'Confirmed outcomes, merges & ended sessions' },
]
export const columnsFor = (state: BoardState) => [...BUILTIN_COLUMNS, ...viewFor({ state }).customColumns.map(c => ({ ...c, description: 'Manual placement' }))]

export function pageTitle(page: string, cards: BoardState['cards'], selected: string | null = null): string {
  const count = Object.values(cards).filter(c => c.column === 'needs_you').length
  const label = page === 'history' ? 'History' : page === 'settings' ? 'Settings'
    : (selected && cards[selected]?.title) || 'Board'

  return `${count > 0 ? `(${count}) ` : ''}${label} · Pnyx`
}

export function filterCards(state: BoardState, workspace: string, tag: string, query = ''): Card[] {
  const words = query.toLowerCase().trim()
    .split(/\s+/)
    .filter(Boolean)

  return Object.values(state.cards).filter(c => (!workspace || c.workspace === workspace) && (!tag || c.tags.includes(tag)) && words.every(w => [c.title, c.key, ...c.tags, ...c.links.map(l => `${l.number ?? ''} ${l.title ?? ''}`)].join(' ').toLowerCase()
    .includes(w)))
    .sort((a,b) => b.updatedSeq - a.updatedSeq || a.id.localeCompare(b.id))
}

// The "Find a card" box: every card the filter above matches, in its order, then
// the other cards the board's search found, best first, within the same workspace
// and tag filters.
export function findBoxCards(
  state: BoardState,
  workspace: string,
  tag: string,
  query: string,
  found: string[],
): Card[] {
  const local = filterCards(state, workspace, tag, query)
  const seen = new Set(local.map(c => c.id))
  const added = (c: Card | undefined): c is Card => !!c && !seen.has(c.id)
    && (!workspace || c.workspace === workspace) && (!tag || c.tags.includes(tag))

  return [...local, ...found.map(id => state.cards[id]).filter(added)]
}

export function visibleParent(card: Card, visible: Card[]): Card | undefined {
  return visible.find(c => c.id === card.parentId)
}

export function safeLink(link: Link): string | undefined {
  try {
    const url = new URL(link.url)

    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

// The live hook session's activity while it runs, otherwise the latest status line.
export const shownActivity = ({ card }: { card: Card }) =>
  card.sessionActivity && card.sessionActivity !== 'ended' ? card.sessionActivity : card.activity

// A recorded session's live state, from its hook activity. Task status alone claims none.
export function agentActivity({ card }: { card: Card }): 'working' | 'idle' | 'ended' | 'unknown' | undefined {
  const activity = card.sessionActivity ?? card.activity ?? ''

  if (!card.agent) {
    return undefined
  }

  if (
    activity === 'working'
    || activity === 'compacting'
    || /^(?:running |ran |task: |task done: )/.test(activity)
    || /^\S+ (?:failed|denied)$/.test(activity)
  ) {
    return 'working'
  }

  if (activity === 'ended') {
    return 'ended'
  }

  return /^(?:idle|stopped|started|resumed|compacted|interrupted)\b/.test(activity) ? 'idle' : 'unknown'
}

export const receiptLabel = (state: string) => ({ queued: 'Queued', delivered: 'Delivered', delivery_unknown: 'Delivery unknown', failed: 'Delivery failed' }[state] ?? state)
export const slashPrefix = (text: string, cursor: number) => /^\/[a-z0-9_.:-]*$/i.test(text.slice(0, cursor)) ? text.slice(0, cursor) : null
export const slashMatches = (command: string, prefix: string) => command.replace(/^[$/]/, '').toLowerCase()
  .startsWith(prefix.replace(/^\//, '').toLowerCase())
// A tab reloads when the server it reconnected to serves another build than the page it loaded.
// A page without a build (the Vite dev server) or a server without one never reloads.
export const shouldReload = (loaded: string | undefined, server: string) =>
  Boolean(loaded && server && loaded !== server)

// Hook activity names the tool an agent runs ("running git status"). Under Focus a
// card only says the agent is working.
const TOOL_ACTIVITY = /^(?:running|ran) /
export const focusedActivity = ({ activity, focus }: { activity?: string; focus: boolean }) =>
  focus && TOOL_ACTIVITY.test(activity ?? '') ? 'working' : activity
