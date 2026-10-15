import { HydraError, EVENT_VERSION, LEGACY_COLUMNS, TASK_STATES, type Card, type COLUMNS, type HydraColumn, type HydraConfig, type HydraEvent, type HydraState, type Column, type HydraChange, type TaskStatus } from './model.ts'
import type { Meta, Decision } from './decide.ts'
import { permissionAttention } from './permissions.ts'
import { assignDefined } from './tasks.ts'

export const HYDRA_CARD = '$hydra'
type Role = (typeof COLUMNS)[number]

export const DEFAULT_COLUMNS: HydraColumn[] = [
  { id: 'queued', title: 'Queued', role: 'queued', description: 'Work waiting for a worker to start it.' },
  { id: 'in_progress', title: 'In progress', role: 'in_progress', description: 'Work a live worker is carrying forward.' },
  { id: 'needs_you', title: 'Needs you', role: 'needs_you', description: 'Work that needs the owner to answer a question, grant permission or make a decision.' },
  { id: 'parked', title: 'Parked', role: 'parked', description: 'Work kept for later, without an agent currently taking it forward.' },
  { id: 'done', title: 'Done', role: 'done', description: 'Work whose result has been checked and is complete.' },
]

// Older layouts named In progress `workers_on_it`; a task created there still starts working.
const ROLE_STATUS: Record<string, TaskStatus> = { in_progress: 'working', workers_on_it: 'working', needs_you: 'needs_you', done: 'done', parked: 'paused' }

const legacyColumn = ({ id }: { id: string }) => (LEGACY_COLUMNS as readonly string[]).includes(id)

export function hydraConfig({ state, id = 'default' }: { state: HydraState; id?: string }): HydraConfig {
  return state.config ?? { id, name: id, hydra: { id: 'hydra', kind: 'agent', name: 'Hydra' }, columns: [...structuredClone(DEFAULT_COLUMNS), ...(state.view?.customColumns ?? [])] }
}

// A Firstmate-linked Hydra's default columns follow Firstmate's records, so they cannot be renamed or deleted.
export function lockedColumn({ state, id }: { state: HydraState; id: string }): boolean {
  return state.config?.hydra.kind === 'firstmate' && DEFAULT_COLUMNS.some(c => c.id === id)
}

// The column a role names on this Hydra, when it still has one.
export function roleColumn({ columns, role }: {
  columns: HydraColumn[]
  role: Role
}): Column | undefined {
  return columns.find(c => c.role === role)?.id
}

// The default column a card's latest status belongs in.
export function statusRole({ card }: { card: Card }): Role | undefined {
  const state = card.outcome?.state === 'done' ? 'done' : card.status?.state

  return state === 'done' ? 'done'
    : state === 'needs_you' || state === 'blocked' ? 'needs_you'
      : state === 'paused' ? 'parked'
        : state === 'working' || card.column === 'workers_on_it' ? 'in_progress' : undefined
}

// A legacy layout, or a Firstmate-linked Hydra whose default columns are missing or
// renamed, moves onto the five defaults in order, followed by the owner's own columns.
export function withDefaultColumns({ columns, locked }: {
  columns: HydraColumn[]
  locked: boolean
}): HydraColumn[] {
  const legacy = columns.some(c => legacyColumn({ id: c.id }) || (c.role as string) === 'workers_on_it')
  const drifted = locked
    && DEFAULT_COLUMNS.some(d => columns.find(c => c.id === d.id)?.title !== d.title)

  if (!legacy && !drifted) {
    return columns
  }

  const own = columns.filter(c => !c.role && !legacyColumn({ id: c.id })
    && !DEFAULT_COLUMNS.some(d => d.id === c.id))

  return [
    ...DEFAULT_COLUMNS.map(d => {
      const same = columns.find(c => c.id === d.id)

      return {
        ...d,
        ...(same && !locked ? { title: same.title } : {}),
        ...(same?.description ? { description: same.description } : {}),
      }
    }),
    ...structuredClone(own),
  ]
}

// Moves a Hydra still on an older layout onto the default columns once, placing each
// card whose column goes away by its status.
export function migrateColumns({ state, meta }: { state: HydraState; meta: Meta }): Decision {
  const before = hydraConfig({ state }).columns
  const columns = withDefaultColumns({ columns: before, locked: state.config?.hydra.kind === 'firstmate' })
  const fallback = fallbackColumn({ columns })
  const placements = Object.fromEntries(Object.values(state.cards)
    .filter(card => !columns.some(c => c.id === card.column))
    .map(card => {
      const role = statusRole({ card })

      const after = (role && roleColumn({ columns, role })) ?? fallback

      return [card.id, { before: card.column, after }]
    }))

  if (columns === before && !Object.keys(placements).length) {
    return { skipped: 'unchanged' }
  }

  return hydraEvent({ state, meta: { ...meta, reason: 'Moved onto the default Hydra columns' }, cardId: '$board', change: { type: 'board.columns', data: { columns, before: structuredClone(before), placements, fallback } } })
}

export function fallbackColumn({ columns }: { columns: HydraColumn[] }): Column {
  return (columns.find(c => c.role === 'parked') ?? columns[0]!).id
}

export function refreshTasks({ state, ids }: {
  state: HydraState
  ids?: (string | null | undefined)[]
}): void {
  const columns = hydraConfig({ state }).columns
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

    // Workers on it keeps its cards until the Hydra moves onto the default columns, which places them by status.
    if (!columns.some(c => c.id === card.column) && card.column !== 'workers_on_it') {
      card.column = fallbackColumn({ columns })
    }
  }

  const hydra = state.cards[HYDRA_CARD]
  const ref = state.config?.hydra.session
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
  state: HydraState
  meta: Meta
  cardId: string
  change: Pick<HydraChange, 'type' | 'data'>
}): Decision {
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  const revision = cardId === '$board' ? state.configRevision ?? 0 : state.cards[cardId]?.revision ?? 0

  if (meta.ifRevision !== undefined && meta.ifRevision !== revision) {
    throw new HydraError({ message: `revision ${revision}, not ${meta.ifRevision}`, code: 'REVISION_CONFLICT' })
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
  } as HydraChange

  return { event }
}

export function validateColumns({ columns }: { columns: HydraColumn[] }): void {
  if (!columns.length || new Set(columns.map(c => c.id)).size !== columns.length) {
    throw new HydraError({ message: 'a Hydra needs at least one column and unique column ids', code: 'VALIDATION_ERROR' })
  }

  for (const column of columns) {
    if (!column.title.trim() || column.title.length > 100) {
      throw new HydraError({ message: 'column titles must have 1–100 characters', code: 'VALIDATION_ERROR' })
    }

    if (column.description !== undefined && (typeof column.description !== 'string' || column.description.length > 4000)) {
      throw new HydraError({ message: 'column descriptions must be text of up to 4000 characters', code: 'VALIDATION_ERROR' })
    }
  }
}

export function declareTask({ state, ref, status, note, meta, source, raw }: {
  state: HydraState
  ref: string
  status: string
  note: string
  meta: Meta
  source?: string
  raw?: string
}): Decision {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  if (!card || card.automaticTask || card.id === HYDRA_CARD) {
    throw new HydraError({ message: `task not found: ${ref}`, code: 'NOT_FOUND' })
  }

  const normalized = status === 'needs-you' || status === 'needs you' ? 'needs_you' : status

  if (!(TASK_STATES as readonly string[]).includes(normalized)) {
    throw new HydraError({ message: `use ${TASK_STATES.join(', ')}`, code: 'VALIDATION_ERROR' })
  }

  return hydraEvent({ state, meta, cardId: card.id, change: { type: 'task.declared', data: { state: normalized as TaskStatus, note, ...(source ? { source } : {}), ...(raw ? { raw } : {}) } } })
}

export function applyHydra({ state, event }: { state: HydraState; event: HydraEvent }): boolean {
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
    state.config = structuredClone(event.data)
    state.configured = true
    state.configRevision = (state.configRevision ?? 0) + 1
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

  // Kinds are Hydra settings; saving one does not choose the Hydra.
  if (event.type === 'board.agents') {
    state.config = structuredClone(hydraConfig({ state, id: event.boardId }))
    state.config.agents = structuredClone(event.data.agents)
    state.configRevision = (state.configRevision ?? 0) + 1

    return true
  }

  if (event.type === 'board.columns') {
    state.config = structuredClone(hydraConfig({ state, id: event.boardId }))
    state.config.columns = structuredClone(event.data.columns)
    state.configRevision = (state.configRevision ?? 0) + 1

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
    const columns = hydraConfig({ state }).columns
    const role = columns.find(c => c.id === column)?.role as string | undefined
    const initial = role && ROLE_STATUS[role] && { id: event.id, at: event.at, actor: event.actor, state: ROLE_STATUS[role], note: '' }
    state.cards[event.cardId] = {
      id: event.cardId, key, title, ...(brief !== undefined ? { brief } : {}), titleSet: true, workspace: 'unassigned', tags: [], attention: [], links: [], sourceRefs: [], sessionIds: [], tracking: 'declared', statusLog: initial ? [initial] : [], ...(initial ? { status: initial } : {}), ...(parentId ? { parentId } : {}), ...(folder ? { folder } : {}), column: column ?? roleColumn({ columns, role: 'queued' }) ?? 'parked', revision: 1, createdSeq: event.seq, updatedSeq: event.seq, updatedAt: event.at,
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
