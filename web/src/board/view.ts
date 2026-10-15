import type { BoardState, Card, Link } from '../../../src/core/model.ts'
import { liveTask } from '../../../src/core/tasks.ts'
import { boardConfig } from '../../../src/core/hydra.ts'

export const columnsFor = ({ state }: { state: BoardState }) => {
  return boardConfig({ state }).columns.map(c => ({
    ...c, description: c.role ? 'Follows declared task status' : 'Manual placement',
  }))
}

export function pageTitle({ page, cards, selected = null }: { page: string; cards: BoardState['cards']; selected?: string | null }): string {
  const count = Object.values(cards).filter(c => liveTask({ card: c }) && c.column === 'needs_you').length
  const label = page === 'history' ? 'History' : page === 'settings' ? 'Settings'
    : (selected && cards[selected]?.title) || 'Board'

  return `${count > 0 ? `(${count}) ` : ''}${label} · Pnyx`
}

export function filterCards({ state, workspace, tag, query = '' }: { state: BoardState; workspace: string; tag: string; query?: string }): Card[] {
  const words = query.toLowerCase().trim()
    .split(/\s+/)
    .filter(Boolean)

  return Object.values(state.cards).filter(c => liveTask({ card: c }) && (!workspace || c.workspace === workspace) && (!tag || c.tags.includes(tag)) && words.every(w => [c.title, c.key, ...c.tags, ...c.links.map(l => `${l.number ?? ''} ${l.title ?? ''}`)].join(' ').toLowerCase()
    .includes(w)))
    .sort((a,b) => b.updatedSeq - a.updatedSeq || a.id.localeCompare(b.id))
}

// The "Find a card" box: every card the filter above matches, in its order, then
// the other cards the board's search found, best first, within the same workspace
// and tag filters.
export function findBoxCards(
  { state, workspace, tag, query, meaning: found }: {
    state: BoardState
    workspace: string
    tag: string
    query: string
    meaning: string[]
  },
): Card[] {
  const local = filterCards({ state, workspace, tag, query })
  const seen = new Set(local.map(c => c.id))

  return [...local, ...found.map(id => state.cards[id]).filter((c): c is Card =>
    !!c && liveTask({ card: c }) && !seen.has(c.id)
    && (!workspace || c.workspace === workspace) && (!tag || c.tags.includes(tag)))]
}

export function visibleParent({ card, visible }: {
  card: Card
  visible: Card[]
}): Card | undefined {
  return visible.find(c => c.id === card.parentId)
}

export function safeLink({ link }: { link: Link }): string | undefined {
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

// Hook activity that names a tool or task the agent runs ("running git status").
const TOOL_ACTIVITY = /^(?:running |ran |task: |task done: )|^\S+ (?:failed|denied)$/

// A recorded session's live state, from its hook activity. Task status alone claims none.
export function agentActivity({ card }: { card: Card }): 'working' | 'idle' | 'ended' | 'unknown' | undefined {
  const activity = card.sessionActivity ?? card.activity ?? ''

  if (!card.agent) {
    return undefined
  }

  if (
    activity === 'working'
    || activity === 'compacting'
    || TOOL_ACTIVITY.test(activity)
  ) {
    return 'working'
  }

  if (activity === 'ended') {
    return 'ended'
  }

  return /^(?:idle|stopped|started|resumed|compacted|interrupted)\b/.test(activity) ? 'idle' : 'unknown'
}

export const receiptLabel = ({ state }: { state: string }) => ({ queued: 'Queued', delivered: 'Delivered', delivery_unknown: 'Delivery unknown', failed: 'Delivery failed' }[state] ?? state)
export const slashPrefix = ({ text, cursor }: { text: string; cursor: number }) => /^\/[a-z0-9_.:-]*$/i.test(text.slice(0, cursor)) ? text.slice(0, cursor) : null
export const slashMatches = ({ command, prefix }: { command: string; prefix: string }) => command.replace(/^[$/]/, '').toLowerCase()
  .startsWith(prefix.replace(/^\//, '').toLowerCase())
// A tab reloads when the server it reconnected to serves another build than the page it loaded.
// A page without a build (the Vite dev server) or a server without one never reloads.
export const shouldReload = ({ loaded, server }: { loaded: string | undefined; server: string }) =>
  Boolean(loaded && server && loaded !== server)

// Under Focus a card only says the agent is working.
export const focusedActivity = ({ activity, focus }: { activity?: string; focus: boolean }) =>
  focus && TOOL_ACTIVITY.test(activity ?? '') ? 'working' : activity

export function taskLabel({ card, focus }: { card: Card; focus: boolean }): string {
  if (card.status) {
    return `${card.status.state.replaceAll('_', ' ')}${card.status.note ? `: ${card.status.note}` : ''}`
  }

  return focusedActivity({ activity: shownActivity({ card }), focus })
    ?? card.outcome?.state ?? (card.tracking ? 'Parked' : 'Activity unknown')
}

// A task with no agent and no Firstmate route starts one instead of showing a conversation.
export const needsAgent = ({ card }: { card: Card }) => !card.agent && !card.sourceRefs.some(r => r.adapter === 'firstmate')
