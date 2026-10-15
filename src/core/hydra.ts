import { BoardError, EVENT_VERSION, TASK_STATES, type BoardColumn, type BoardConfig, type BoardEvent, type BoardState, type Column, type HydraEvent, type TaskStatus } from './model.ts'
import type { Meta, Decision } from './decide.ts'
import { permissionAttention } from './permissions.ts'
import { assignDefined } from './tasks.ts'

export const HYDRA_CARD = '$hydra'
export const TEMPLATE_COLUMNS: BoardColumn[] = [
  { id: 'needs_you', title: 'Needs you', role: 'needs_you', description: 'Work that needs the owner to answer a question, grant permission or make a decision.' },
  { id: 'workers_on_it', title: 'Workers on it', role: 'workers_on_it', description: 'Work an attached agent is actively carrying forward.' },
  { id: 'done', title: 'Done', role: 'done', description: 'Work whose result has been checked and is complete.' },
  { id: 'parked', title: 'Parked', role: 'parked', description: 'Work kept for later, without an agent currently taking it forward.' },
]

const ROLE_STATUS = { needs_you: 'needs_you', workers_on_it: 'working', done: 'done', parked: 'paused' } as const satisfies Record<NonNullable<BoardColumn['role']>, TaskStatus>

export function boardConfig({ state, id = 'default' }: { state: BoardState; id?: string }): BoardConfig {
  return state.board ?? { id, name: id, hydra: { id: 'hydra', kind: 'agent', name: 'Hydra' }, columns: [...structuredClone(TEMPLATE_COLUMNS), ...(state.view?.customColumns ?? [])] }
}

export function fallbackColumn({ columns }: { columns: BoardColumn[] }): Column {
  return (columns.find(c => c.role === 'parked') ?? columns[0]!).id
}

export function refreshTasks({ state, ids }: {
  state: BoardState
  ids?: (string | null | undefined)[]
}): void {
  const columns = boardConfig({ state }).columns
  const cards = ids
    ? [...new Set(ids)].flatMap(id => (id && state.cards[id] ? [state.cards[id]] : []))
    : Object.values(state.cards)

  for (const card of cards) {
    permissionAttention({ card })

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

    if (!columns.some(c => c.id === card.column)) {
      card.column = fallbackColumn({ columns })
    }
  }

  const hydra = state.cards[HYDRA_CARD]
  const ref = state.board?.hydra.session
  const session = ref ? state.sessions?.[ref] : undefined

  if (hydra) {
    if (session && hydra.launch?.via === 'command' && session.launch?.via === 'hooks') {
      session.launch = { ...hydra.launch, harness: session.agent.provider }
    }

    hydra.sessionIds = session ? [session.id] : []
    assignDefined({
      target: hydra,
      values: {
        agent: session && { ...session.agent },
        terminal: session?.terminal && { ...session.terminal },
      },
    })
    hydra.attention = session ? [...session.attention] : []
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

    if (column.description !== undefined && (typeof column.description !== 'string' || column.description.length > 4000)) {
      throw new BoardError({ message: 'column descriptions must be text of up to 4000 characters', code: 'VALIDATION_ERROR' })
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
  if (event.type === 'hydra.memory') {
    state.hydraMemory ??= {}

    if (event.data.after === null) {
      delete state.hydraMemory[event.data.key]
    } else {
      state.hydraMemory[event.data.key] = { text: event.data.after, at: event.at }
    }

    return true
  }

  if (event.type === 'task.brief' || event.type === 'task.visibility') {
    const card = state.cards[event.cardId]

    if (card) {
      if (event.type === 'task.brief') {
        card.brief = event.data.after
      } else {
        card.hidden = event.data.after
      }

      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }

    return true
  }

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

  // Kinds are board settings; saving one does not choose the board's Hydra.
  if (event.type === 'board.agents') {
    state.board = structuredClone(boardConfig({ state, id: event.boardId }))
    state.board.agents = structuredClone(event.data.agents)
    state.boardRevision = (state.boardRevision ?? 0) + 1

    return true
  }

  if (event.type === 'board.columns') {
    state.board = structuredClone(boardConfig({ state, id: event.boardId }))
    state.board.columns = structuredClone(event.data.columns)
    state.boardRevision = (state.boardRevision ?? 0) + 1

    for (const card of Object.values(state.cards)) {
      const placement = event.data.placements?.[card.id]

      if (placement?.after) {
        card.column = placement.after
      }

      if (!event.data.columns.some(c => c.id === card.column)) {
        card.column = event.data.fallback ?? event.data.columns[0]!.id
      }

      if (placement) {
        card.revision++
        card.updatedSeq = event.seq
        card.updatedAt = event.at
      }
    }

    refreshTasks({ state })

    return true
  }

  if (event.type === 'task.created') {
    const { key, title, brief, parentId, column, folder } = event.data
    const role = boardConfig({ state }).columns.find(c => c.id === column)?.role
    const initial = role && { id: event.id, at: event.at, actor: event.actor, state: ROLE_STATUS[role], note: '' }
    state.cards[event.cardId] = {
      id: event.cardId, key, title, ...(brief !== undefined ? { brief } : {}), titleSet: true, workspace: 'unassigned', tags: [], attention: [], links: [], sourceRefs: [], sessionIds: [], tracking: 'declared', statusLog: initial ? [initial] : [], ...(initial ? { status: initial } : {}), ...(parentId ? { parentId } : {}), ...(folder ? { folder } : {}), column: column ?? 'parked', revision: 1, createdSeq: event.seq, updatedSeq: event.seq, updatedAt: event.at,
    }
    state.keys[key] = event.cardId
    refreshTasks({ state, ids: [event.cardId] })

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
      refreshTasks({ state, ids: [card.id] })
    }

    return true
  }

  if (event.type === 'task.launched') {
    const card = state.cards[event.cardId]

    if (card) {
      card.launch = structuredClone(event.data)
      card.revision++
      card.updatedAt = event.at
      card.updatedSeq = event.seq
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
