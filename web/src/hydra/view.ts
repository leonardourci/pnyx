import type { HydraState } from '../../../src/app/model.ts'
import type { Card, HydraColumn, Link } from '../../../src/core/model.ts'
import { cardDoneDeadline, HOUR_MS } from '../../../src/core/retention.ts'
import { liveTask, rankOf } from '../../../src/core/tasks.ts'
import { hydraConfig } from '../../../src/core/hydra.ts'
import { asksOwner } from '../../../src/core/lifecycle.ts'
import { openAsks } from '../../../src/core/asks.ts'

const HARNESSES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export const hydraTitle = ({ name }: { name: string }) => name || 'Untitled'

export const harnessName = ({ provider }: { provider: string }) => HARNESSES[provider] ?? provider

// A column's icon and color come from its role; a custom column has its own icon.
export const columnLook = ({ column }: { column: Pick<HydraColumn, 'id' | 'role'> }) => ({
  icon: column.role ?? (column.id.startsWith('custom:') ? 'custom' : column.id),
  tone: `column-${column.role ?? column.id}`,
})

export const columnsFor = ({ state }: { state: HydraState }) => {
  return hydraConfig({ state }).columns
}

export function pageTitle({
  cards,
  selected = null,
  needsYou = 'needs_you',
}: {
  cards: HydraState['cards']
  selected?: string | null
  needsYou?: string
}): string {
  const count = Object.values(cards)
    .filter(c => liveTask({ card: c }) && c.column === needsYou).length
  const label = (selected && cards[selected]?.title) || 'Hydra'

  return `${count > 0 ? `(${count}) ` : ''}${label} · Pnyx`
}

export function filterCards({
  state,
  workspace,
  tag,
  query = '',
}: {
  state: HydraState
  workspace: string
  tag: string
  query?: string
}): Card[] {
  const words = query.toLowerCase().trim()
    .split(/\s+/)
    .filter(Boolean)

  return Object.values(state.cards).filter(c => liveTask({ card: c })
    && (!workspace || c.workspace === workspace)
    && (!tag || c.tags.includes(tag))
    && words.every(w => [
      c.title,
      c.project ?? '',
      c.key,
      ...c.tags,
      ...c.links.map(l => `${l.number ?? ''} ${l.title ?? ''}`),
    ].join(' ').toLowerCase()
      .includes(w)))
    .sort((
      a,
      b,
    ) => rankOf({ card: a }) - rankOf({ card: b }) || a.id.localeCompare(b.id))
}

// The "Find a card" box: every card the filter above matches, in its order, then
// the other cards the Hydra's search found, best first, within the same workspace
// and tag filters.
export function findBoxCards(
  {
    state,
    workspace,
    tag,
    query,
    meaning: found,
  }: {
    state: HydraState
    workspace: string
    tag: string
    query: string
    meaning: string[]
  },
): Card[] {
  const local = filterCards({
    state,
    workspace,
    tag,
    query,
  })
  const seen = new Set(local.map(c => c.id))

  return [
    ...local,
    ...found.map(id => state.cards[id]).filter((c): c is Card =>
      !!c && liveTask({ card: c }) && !seen.has(c.id)
    && (!workspace || c.workspace === workspace) && (!tag || c.tags.includes(tag))),
  ]
}

export function visibleParent({
  card,
  visible,
}: {
  card: Card
  visible: Card[]
}): Card | undefined {
  return visible.find(c => c.id === card.parentId)
}

export function safeLink({ link }: { link: Link }): string | undefined {
  try {
    const url = new URL(link.url)

    return [
      'https:',
      'http:',
    ].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

export const shownActivity = ({ card }: { card: Card }) =>
  card.sessionActivity && card.sessionActivity !== 'ended' ? card.sessionActivity : card.activity

// A worker whose session ended is stopped, so a dead job never reads as active.
export function agentActivity({ card }: { card: Card }): 'working' | 'finished' | 'stopped' | undefined {
  if (!card.agent) {
    return undefined
  }

  const activity = card.sessionActivity ?? card.activity

  return activity === 'ended' || card.outcome?.state === 'ended' ? 'stopped' : activity === 'working' ? 'working' : activity === 'finished' ? 'finished' : undefined
}

// The card a dragged task goes above when dropped on `over`: `over` itself, or the
// next card when dropped on its lower half. Undefined means the end of the column.
export function dropBefore({
  cards,
  over,
  below,
}: {
  cards: Card[]
  over?: string
  below: boolean
}): string | undefined {
  const index = cards.findIndex(c => c.id === over)

  return index < 0 ? undefined : cards[below ? index + 1 : index]?.id
}

export const receiptLabel = ({ state }: { state: string }) => ({
  queued: 'Queued',
  delivered: 'Delivered',
  delivery_unknown: 'Delivery unknown',
  failed: 'Delivery failed',
}[state] ?? state)
export const slashPrefix = ({
  text,
  cursor,
}: {
  text: string
  cursor: number
}) => /(?:^|\s)(\/[a-z0-9_.:-]*)$/i.exec(text.slice(
  0,
  cursor,
))?.[1] ?? null
export const slashMatches = ({
  command,
  prefix,
}: {
  command: string
  prefix: string
}) => command.replace(
  /^[$/]/,
  '',
).toLowerCase()
  .startsWith(prefix.replace(
    /^\//,
    '',
  ).toLowerCase())
export const shouldReload = ({
  loaded,
  server,
}: {
  loaded: string | undefined
  server: string
}) =>
  Boolean(loaded && server && loaded !== server)

export function taskLabel({ card }: { card: Card }): string {
  if (card.status) {
    return `${card.status.state.replaceAll(
      '_',
      ' ',
    )}${card.status.note ? `: ${card.status.note}` : ''}`
  }

  return shownActivity({ card })
    ?? card.outcome?.state ?? (card.tracking ? 'No status' : 'Activity unknown')
}

export const needsAgent = ({ card }: { card: Card }) => !card.agent && !card.sourceRefs.some(r => r.adapter === 'firstmate')

export function projectTitle({ project }: { project: string }): string {
  return project.startsWith('/') ? project.split('/').filter(Boolean)
    .at(-1) ?? project : project
}

export function elapsedTime({
  at,
  now,
}: {
  at: string
  now: number
}): string {
  const elapsed = Math.max(
    0,
    now - Date.parse(at),
  )

  return elapsed < 60_000 ? 'just now' : elapsed < HOUR_MS ? `${Math.floor(elapsed / 60_000)}m ago`
    : elapsed < 24 * HOUR_MS ? `${Math.floor(elapsed / HOUR_MS)}h ago` : `${Math.floor(elapsed / (24 * HOUR_MS))}d ago`
}

export function cardState({
  card,
  hours,
  now,
}: {
  card: Card
  hours?: number
  now: number
}): {
  kind: string
  text: string
  at?: string
} {
  if (card.doneAt) {
    const deadline = cardDoneDeadline({
      card,
      hours,
    })
    const remaining = deadline === undefined ? undefined : deadline - now

    return {
      kind: 'done',
      text: remaining !== undefined && remaining <= 6 * HOUR_MS
        ? `hidden in ${remaining > HOUR_MS ? `${Math.ceil(remaining / HOUR_MS)}h` : `${Math.max(
          1,
          Math.ceil(remaining / 60_000),
        )}m`}`
        : `done · ${elapsedTime({
          at: card.doneAt,
          now,
        })}`,
      at: card.doneAt,
    }
  }

  if (asksOwner({ card })) {
    return {
      kind: 'asks',
      text: 'asks',
    }
  }

  if (card.hold) {
    return {
      kind: 'paused',
      text: 'talking',
      at: card.hold.at,
    }
  }

  const activity = agentActivity({ card })

  if (activity === 'stopped') {
    const at = card.stoppedAt ?? card.updatedAt

    return {
      kind: 'stopped',
      text: `stopped · ${elapsedTime({
        at,
        now,
      })}`,
      at,
    }
  }

  if (activity !== 'working' && openAsks({
    card,
    audience: 'hydra',
  }).length) {
    return {
      kind: 'asks-hydra',
      text: 'asks Hydra',
    }
  }

  return {
    kind: activity ?? 'not-started',
    text: activity === 'working' ? 'working' : activity === 'finished' ? 'finished its turn' : card.agent ? 'activity unknown' : 'not started',
  }
}

export function expandedByColumn({
  ids,
  cards,
  pending,
}: {
  ids: string[]
  cards: Record<string, Card>
  pending: Record<string, string>
}): string[] {
  const columnOf = ({ id }: { id: string }) => cards[id]?.column ?? pending[id] ?? id
  const open = new Set<string>(), kept: string[] = []

  for (const id of [...ids].reverse()) {
    const column = columnOf({ id })

    if (!open.has(column)) {
      open.add(column)
      kept.push(id)
    }
  }

  return kept.reverse()
}
