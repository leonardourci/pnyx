// Hydra's work records. No I/O, timers or inferred state transitions.
import { BoardError, EVENT_VERSION, TASK_STATES, type BoardColumn, type BoardConfig, type BoardEvent, type BoardState, type Card, type Column, type HydraEvent, type TaskStatus } from './model.ts'
import type { Meta, Decision } from './decide.ts'

export const HYDRA_CARD = '$hydra'
export const TEMPLATE_COLUMNS: BoardColumn[] = [
  { id: 'needs_you', title: 'Needs you', role: 'needs_you' },
  { id: 'workers_on_it', title: 'Workers on it', role: 'workers_on_it' },
  { id: 'done', title: 'Done', role: 'done' },
  { id: 'parked', title: 'Parked', role: 'parked' },
]

const ROLE_STATUS = { needs_you: 'needs_you', workers_on_it: 'working', done: 'done', parked: 'paused' } as const satisfies Record<NonNullable<BoardColumn['role']>, TaskStatus>

export function boardConfig({ state, id = 'default' }: { state: BoardState; id?: string }): BoardConfig {
  return state.board ?? { id, name: id, hydra: { id: 'hydra', kind: 'agent', name: 'Hydra' }, columns: [...structuredClone(TEMPLATE_COLUMNS), ...(state.view?.customColumns ?? [])] }
}

export function taskColumn({ state, card }: { state: BoardState; card: Card }): Column {
  const columns = boardConfig({ state }).columns

  if (card.manualColumn && columns.some(c => c.id === card.manualColumn)) {
    return card.manualColumn
  }

  const prs = card.links.filter(l => l.kind === 'github_pr')
  const merged = prs.length > 0 && prs.every(l => l.state === 'merged')
  // Preserve legacy Firstmate status until its full mirror is imported.
  const legacyVerb = card.activity?.split(':')[0]?.trim()
  const legacy: TaskStatus = card.outcome?.source === 'firstmate' ? 'done'
    : card.attention.some(a => !a.key.startsWith('hook:')) ? 'needs_you'
      : legacyVerb === 'working' ? 'working' : legacyVerb === 'done' ? 'done'
        : legacyVerb === 'failed' || legacyVerb === 'blocked' ? 'blocked' : 'paused'
  const firstmate = card.sourceRefs.some(r => r.adapter === 'firstmate')
  const status = card.status?.state ?? (firstmate ? legacy : 'paused')
  const role = merged || status === 'done' ? 'done' : status === 'working' ? 'workers_on_it'
    : status === 'needs_you' || status === 'blocked' ? 'needs_you' : 'parked'

  return (columns.find(c => c.role === role) ?? columns.find(c => c.role === 'parked') ?? columns[0]!).id
}

export function refreshTasks({ state }: { state: BoardState }): void {
  const columns = boardConfig({ state }).columns

  for (const card of Object.values(state.cards)) {
    if (card.automaticTask || card.sourceRefs.some(r => r.adapter === 'firstmate' && r.objectId === '@home')) {
      card.hidden = true
    }

    if (card.sourceRefs.some(r => r.adapter === 'firstmate' && r.objectId !== '@home')
      || (state.configured && !card.hidden && card.id !== HYDRA_CARD)) {
      card.tracking = 'declared'
    }

    // Legacy Firstmate home cards were grouping parents, not work.
    if ((state.configured || card.tracking) && card.parentId && state.cards[card.parentId]?.sourceRefs.some(r => r.adapter === 'firstmate' && r.objectId === '@home')) {
      delete card.parentId
    }

    if (card.tracking === 'declared') {
      card.column = taskColumn({ state, card })
    } else if (!columns.some(c => c.id === card.column)) {
      card.column = (columns.find(c => c.role === 'parked') ?? columns[0]!).id
    }
  }

  const hydra = state.cards[HYDRA_CARD]
  const ref = state.board?.hydra.session
  const session = ref ? state.sessions?.[ref] : undefined

  if (hydra) {
    hydra.sessionIds = session ? [session.id] : []
    hydra.agent = session ? { ...session.agent } : undefined
    hydra.terminal = session?.terminal && { ...session.terminal }
    hydra.hidden = true
  }
}

export function hydraEvent({ state, meta, cardId, change }: {
  state: BoardState
  meta: Meta
  cardId: string
  change: Pick<HydraEvent, 'type' | 'data'>
}): Decision {
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  const revision = cardId === '$board' ? state.boardRevision ?? 0 : state.cards[cardId]?.revision ?? 0

  if (meta.ifRevision !== undefined && meta.ifRevision !== revision) {
    throw new BoardError({ message: `revision ${revision}, not ${meta.ifRevision}`, code: 'REVISION_CONFLICT' })
  }

  let id = meta.id ?? `evt_${state.seq + 1}`

  for (let n = 2; !meta.id && id in state.eventIds; n++) {
    id = `evt_${state.seq + 1}_${n}`
  }

  const event = {
    v: EVENT_VERSION,
    seq: state.seq + 1,
    id,
    at: meta.at,
    actor: meta.actor,
    cardId,
    ...(meta.reason ? { reason: meta.reason } : {}),
    ...change,
  } as HydraEvent

  return { event }
}

export function validateColumns({ columns }: { columns: BoardColumn[] }): void {
  if (!columns.length || new Set(columns.map(c => c.id)).size !== columns.length) {
    throw new BoardError({ message: 'a board needs at least one column and unique column ids', code: 'VALIDATION_ERROR' })
  }

  for (const column of columns) {
    if (!column.title.trim() || column.title.length > 100) {
      throw new BoardError({ message: 'column titles must have 1–100 characters', code: 'VALIDATION_ERROR' })
    }
  }
}

export function declareTask({ state, ref, status, note, meta, source, raw }: {
  state: BoardState
  ref: string
  status: string
  note: string
  meta: Meta
  source?: string
  raw?: string
}): Decision {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  if (!card || card.automaticTask || card.id === HYDRA_CARD) {
    throw new BoardError({ message: `task not found: ${ref}`, code: 'NOT_FOUND' })
  }

  const normalized = status === 'needs-you' || status === 'needs you' ? 'needs_you' : status

  if (!(TASK_STATES as readonly string[]).includes(normalized)) {
    throw new BoardError({ message: `use ${TASK_STATES.join(', ')}`, code: 'VALIDATION_ERROR' })
  }

  return hydraEvent({ state, meta, cardId: card.id, change: { type: 'task.declared', data: { state: normalized as TaskStatus, note, ...(source ? { source } : {}), ...(raw ? { raw } : {}) } } })
}

export function applyHydra({ state, event }: { state: BoardState; event: BoardEvent }): boolean {
  if (event.type === 'board.configured') {
    state.board = structuredClone(event.data)
    state.configured = true
    state.boardRevision = (state.boardRevision ?? 0) + 1
    state.cards[HYDRA_CARD] ??= {
      id: HYDRA_CARD, key: HYDRA_CARD, title: 'Hydra', workspace: 'unassigned', tags: [], attention: [], links: [], sourceRefs: [], hidden: true, column: 'parked', revision: 0, createdSeq: event.seq, updatedSeq: event.seq, updatedAt: event.at,
    }
    const hydra = state.cards[HYDRA_CARD]!
    hydra.title = event.data.hydra.name
    hydra.hidden = true
    state.keys[HYDRA_CARD] = HYDRA_CARD
    refreshTasks({ state })

    return true
  }

  if (event.type === 'board.columns') {
    state.board = structuredClone(boardConfig({ state, id: event.boardId }))
    state.board.columns = structuredClone(event.data.columns)
    state.boardRevision = (state.boardRevision ?? 0) + 1

    for (const card of Object.values(state.cards)) {
      const placement = event.data.placements?.[card.id]

      if (placement) {
        if (placement.after) {
          card.manualColumn = placement.after
        } else {
          delete card.manualColumn
        }

        card.revision++
        card.updatedSeq = event.seq
        card.updatedAt = event.at
      }

      if (card.manualColumn && !event.data.columns.some(c => c.id === card.manualColumn)) {
        card.manualColumn = event.data.fallback ?? event.data.columns[0]!.id
        card.revision++
        card.updatedSeq = event.seq
        card.updatedAt = event.at
      }

      if (!event.data.columns.some(c => c.id === card.column)) {
        card.column = event.data.fallback ?? event.data.columns[0]!.id
      }
    }

    refreshTasks({ state })

    return true
  }

  if (event.type === 'task.created') {
    const { key, title, parentId, column, folder } = event.data
    const role = boardConfig({ state }).columns.find(c => c.id === column)?.role
    const initial = role && { id: event.id, at: event.at, actor: event.actor, state: ROLE_STATUS[role], note: '' }
    state.cards[event.cardId] = {
      id: event.cardId, key, title, titleSet: true, workspace: 'unassigned', tags: [], attention: [], links: [], sourceRefs: [], sessionIds: [], tracking: 'declared', statusLog: initial ? [initial] : [], ...(initial ? { status: initial } : {}), ...(parentId ? { parentId } : {}), ...(column && !role ? { manualColumn: column } : {}), ...(folder ? { folder } : {}), column: column ?? 'parked', revision: 1, createdSeq: event.seq, updatedSeq: event.seq, updatedAt: event.at,
    }
    state.keys[key] = event.cardId
    refreshTasks({ state })

    return true
  }

  if (event.type === 'task.declared' || event.type === 'task.mirrored') {
    const card = state.cards[event.cardId]

    if (card) {
      card.tracking = 'declared'

      if (event.type === 'task.declared') {
        const declaration = { ...event.data, id: event.id, at: event.at, actor: event.actor }
        card.statusLog = [...(card.statusLog ?? []), declaration]
        card.status = declaration
      } else {
        card.mirror = structuredClone(event.data)
      }

      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
      refreshTasks({ state })
    }

    return true
  }

  if (event.type === 'hydra.message') {
    const message = { ...event.data, id: event.id, at: event.at, actor: event.actor }
    state.hydraMessages = [...(state.hydraMessages ?? []), message]
    const card = event.data.task ? state.cards[event.data.task] : undefined

    if (card) {
      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }

    return true
  }

  return false
}
