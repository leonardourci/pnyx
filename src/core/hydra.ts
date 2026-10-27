import { openAsks } from './asks.ts'
import { requireReportReview } from '../investigation/inventory.ts'
import { ownerGates } from './gates.ts'
import { columnRule, validateColumnRule } from './columns.ts'
import { HydraError, EVENT_VERSION, LEGACY_COLUMNS, LEGACY_IN_PROGRESS, TASK_STATES, type Card, type COLUMNS, type HydraColumn, type HydraConfig, type HydraMessage, type Column, type Link, type TaskStatus, type TaskDeclaration } from './model.ts'
import { type HydraState, type HydraChange } from '../app/model.ts'
import type { Meta, Decision } from './decide.ts'
import { permissionAttention } from './permissions.ts'
import { assignDefined } from './tasks.ts'

export const HYDRA_CARD = '$hydra'
type Role = (typeof COLUMNS)[number]

const ROLE_COLUMNS: HydraColumn[] = [
  {
    id: 'queued',
    title: 'Queued',
    role: 'queued',
    description: 'Work waiting for a worker to start it.',
  },
  {
    id: 'in_progress',
    title: 'In progress',
    role: 'in_progress',
    description: 'Work a live worker is carrying forward.',
  },
  {
    id: 'needs_you',
    title: 'Needs you',
    role: 'needs_you',
    description: 'Work that needs the owner to answer a question, grant permission or make a decision.',
  },
  {
    id: 'parked',
    title: 'Parked',
    role: 'parked',
    description: 'Work kept for later, without an agent currently taking it forward.',
  },
  {
    id: 'done',
    title: 'Done',
    role: 'done',
    description: 'Work whose result has been checked and is complete.',
  },
]

export const DEFAULT_COLUMNS = ROLE_COLUMNS.map(column => ({
  ...column,
  rule: structuredClone(columnRule({ column })),
}))

// A task created in an older layout's Workers on it column still starts working.
export const ROLE_STATUS: Partial<Record<NonNullable<HydraColumn['role']>, TaskStatus>> = {
  in_progress: 'working',
  [LEGACY_IN_PROGRESS]: 'working',
  needs_you: 'needs_you',
  done: 'done',
  parked: 'paused',
}

const legacyColumn = ({ id }: { id: Column }) => LEGACY_COLUMNS.some(legacy => legacy === id)

// ponytail: a never-configured Hydra replays onto the defaults directly, so only its cards moved into Workers on it get placed by status; record a layout version if such logs ever matter.
export function hydraConfig({
  state,
  id = 'default',
}: {
  state: HydraState
  id?: string
}): HydraConfig {
  return state.config ?? {
    id,
    name: id,
    hydra: {
      id: 'hydra',
      kind: 'agent',
      name: 'Hydra',
    },
    columns: [
      ...structuredClone(DEFAULT_COLUMNS),
      ...(state.view?.customColumns ?? []),
    ],
  }
}

export const LOCKED_DELETE = "Can't delete: this column is tied to Firstmate's records"

// A Firstmate-linked Hydra's default columns follow Firstmate's records by role, so they can be renamed but not deleted.
export function lockedColumn({
  state,
  id,
}: {
  state: HydraState
  id: string
}): boolean {
  const role = state.config?.columns.find(c => c.id === id)?.role

  return state.config?.hydra.kind === 'firstmate' && DEFAULT_COLUMNS.some(c => c.role === role)
}

export function roleColumn({
  columns,
  role,
}: {
  columns: HydraColumn[]
  role: Role
}): Column | undefined {
  return columns.find(c => c.role === role)?.id
}

function statusRole({ card }: { card: Card }): Role | undefined {
  const state = card.outcome?.state === 'done' ? 'done' : card.status?.state

  if (state === 'done') {
    return 'done'
  }

  if (ownerGates({ card }).length || card.reminder?.dueAt) {
    return 'needs_you'
  }

  if (card.hold) {
    return 'queued'
  }

  if (state === 'paused') {
    return 'parked'
  }

  if (state === 'working' || state === 'needs_you' || state === 'blocked'
    || card.column === LEGACY_IN_PROGRESS) {
    return 'in_progress'
  }

  return undefined
}

// Rebuilt only for a legacy layout, or a Firstmate-linked Hydra missing a default role; the owner's own columns follow.
function withDefaultColumns({
  columns,
  locked,
}: {
  columns: HydraColumn[]
  locked: boolean
}): HydraColumn[] {
  const legacy = columns.some(c => legacyColumn({ id: c.id }) || c.role === LEGACY_IN_PROGRESS)
  const missing = locked && DEFAULT_COLUMNS.some(d => !columns.some(c => c.role === d.role))

  if (!legacy && !missing) {
    return columns
  }

  const own = columns.filter(c => !c.role && !legacyColumn({ id: c.id })
    && !DEFAULT_COLUMNS.some(d => d.id === c.id))

  return [
    ...DEFAULT_COLUMNS.map(d => structuredClone(columns.find(c => c.role === d.role) ?? d)),
    ...structuredClone(own),
  ]
}

// Cards whose column goes away are placed by status, so this runs once per older layout.
export function migrateColumns({
  state,
  meta,
}: {
  state: HydraState
  meta: Meta
}): Decision {
  const before = hydraConfig({ state }).columns
  const layout = withDefaultColumns({
    columns: before,
    locked: state.config?.hydra.kind === 'firstmate',
  })
  const missingRules = layout.some(column => column.rule === undefined)
  const columns = missingRules ? layout.map(column => ({
    ...column,
    rule: structuredClone(columnRule({ column })),
  })) : layout
  const fallback = fallbackColumn({ columns })
  const placements = Object.fromEntries(Object.values(state.cards)
    .filter(card => !columns.some(c => c.id === card.column))
    .map(card => {
      const role = statusRole({ card })

      const after = (role && roleColumn({
        columns,
        role,
      })) ?? fallback

      return [
        card.id,
        {
          before: card.column,
          after,
        },
      ]
    }))

  if (columns === before && !Object.keys(placements).length) {
    return { skipped: 'unchanged' }
  }

  return hydraEvent({
    state,
    meta: {
      ...meta,
      reason: 'Moved onto the default Hydra columns',
    },
    cardId: '$board',
    change: {
      type: 'board.columns',
      data: {
        columns,
        before: structuredClone(before),
        placements,
        fallback,
      },
    },
  })
}

export function fallbackColumn({ columns }: { columns: HydraColumn[] }): Column {
  return (columns.find(c => c.role === 'parked') ?? columns[0]!).id
}

export function refreshTasks({
  state,
  ids,
}: {
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
    if (!columns.some(c => c.id === card.column) && card.column !== LEGACY_IN_PROGRESS) {
      card.column = fallbackColumn({ columns })
    }
  }

  const hydra = state.cards[HYDRA_CARD]
  const ref = state.config?.hydra.session
  const session = ref ? state.sessions?.[ref] : undefined

  if (hydra) {
    if (session && hydra.launch?.via === 'command' && session.launch?.via === 'hooks') {
      session.launch = {
        ...hydra.launch,
        harness: session.agent.provider,
      }
    }

    hydra.sessionIds = session ? [session.id] : []
    assignDefined({
      target: hydra,
      values: {
        agent: session && { ...session.agent },
        terminal: session?.terminal && { ...session.terminal },
        ...(session?.agent.host === 'pnyx' ? {
          settings: session.settings && { ...session.settings },
          activity: session.activity,
          sessionActivity: session.sessionActivity ?? session.activity,
          workingSince: session.workingSince,
        } : {}),
      },
    })
    hydra.attention = session?.agent.host === 'pnyx'
      ? [
        ...hydra.attention.filter(a => !a.key.startsWith('hook:')),
        ...session.attention,
      ]
      : session ? [...session.attention] : []
    hydra.hidden = true
  }
}

export function hydraEvent({
  state,
  meta,
  cardId,
  change,
}: {
  state: HydraState
  meta: Meta
  cardId: string
  change: Pick<HydraChange, 'type' | 'data'>
}): Decision {
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  if (change.type === 'task.visibility' && 'after' in change.data && change.data.after === true) {
    const card = state.cards[cardId]

    if (card) {
      requireReportReview({
        state,
        card,
      })

      if (openAsks({ card }).some(ask => ask.origin)) {
        throw new HydraError({
          message: 'answer or evidence-close the report question before hiding its task',
          code: 'OWNER_DECISION_PENDING',
        })
      }
    }
  }

  const revision = cardId === '$projects' ? state.projectsRevision ?? 0 : cardId === '$board' ? state.configRevision ?? 0 : state.cards[cardId]?.revision ?? 0

  if (meta.ifRevision !== undefined && meta.ifRevision !== revision) {
    throw new HydraError({
      message: `revision ${revision}, not ${meta.ifRevision}`,
      code: 'REVISION_CONFLICT',
    })
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

  if (meta.details) {
    event.details = meta.details
  }

  return { event }
}

export function validateColumns({ columns }: { columns: HydraColumn[] }): void {
  if (!columns.length || new Set(columns.map(c => c.id)).size !== columns.length) {
    throw new HydraError({
      message: 'a Hydra needs at least one column and unique column ids',
      code: 'VALIDATION_ERROR',
    })
  }

  for (const column of columns) {
    if (column.rule !== undefined) {
      validateColumnRule({ rule: column.rule })
    }

    if (!column.title.trim() || column.title.length > 100) {
      throw new HydraError({
        message: 'column titles must have 1–100 characters',
        code: 'VALIDATION_ERROR',
      })
    }

    if (column.description !== undefined && (typeof column.description !== 'string' || column.description.length > 4000)) {
      throw new HydraError({
        message: 'column descriptions must be text of up to 4000 characters',
        code: 'VALIDATION_ERROR',
      })
    }
  }
}

// A declared state as shown to people and Hydra: a paused wait names its end, a hold says it has none.
export function declaredState({ declaration }: { declaration: Pick<TaskDeclaration, 'state' | 'until' | 'hold'> }): string {
  if (declaration.until) {
    return `${declaration.state} until ${declaration.until}`
  }

  if (declaration.hold) {
    return `${declaration.state} on hold`
  }

  return declaration.state
}

export function declareTask({
  state,
  ref,
  status,
  note,
  meta,
  source,
  raw,
  until,
  waitingFor,
  restores,
  hold,
}: {
  state: HydraState
  ref: string
  status: string
  note: string
  meta: Meta
  source?: string
  raw?: string
  until?: string
  waitingFor?: string[]
  restores?: string
  hold?: boolean
}): Decision {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  if (!card || card.automaticTask || card.id === HYDRA_CARD) {
    throw new HydraError({
      message: `task not found: ${ref}`,
      code: 'NOT_FOUND',
    })
  }

  if (status === 'done') {
    requireReportReview({
      state,
      card,
    })
  }

  const normalized = status === 'needs-you' || status === 'needs you' ? 'needs_you' : status

  if (!(TASK_STATES as readonly string[]).includes(normalized)) {
    throw new HydraError({
      message: `use ${TASK_STATES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    })
  }

  if (until !== undefined && normalized !== 'paused') {
    throw new HydraError({
      message: '--until goes only with paused',
      code: 'VALIDATION_ERROR',
    })
  }

  if (hold && normalized !== 'paused') {
    throw new HydraError({
      message: '--hold goes only with paused',
      code: 'VALIDATION_ERROR',
    })
  }

  if (hold && until !== undefined) {
    throw new HydraError({
      message: 'a hold has no end; use --hold or --until, not both',
      code: 'VALIDATION_ERROR',
    })
  }

  const data: Omit<TaskDeclaration, 'id' | 'at' | 'actor'> = {
    state: normalized as TaskStatus,
    note,
  }

  if (normalized === 'needs_you' || normalized === 'blocked') {
    const gates = waitingFor ?? ownerGates({ card })

    if (gates.length || waitingFor) {
      data.waitingFor = gates
    }
  }

  if (restores) {
    data.restores = restores
  }

  if (source) {
    data.source = source
  }

  if (raw) {
    data.raw = raw
  }

  if (until) {
    data.until = until
  }

  if (hold) {
    data.hold = true
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.declared',
      data,
    },
  })
}

// Hydra ends a turn that needs nothing from the owner with only this reply, which its chat hides.
export const QUIET_REPLY = 'NO_REPLY'

// Pnyx itself, a hook, a session or a worker: an agent's write, never the owner's or Hydra's.
export const agentActor = ({ actor }: { actor: string }) => /^(pnyx$|hook:|session:|worker:)/.test(actor)

// A worker's or session's message to Hydra is its report, never the owner's words.
export const reportActor = ({ actor }: { actor: string }) => actor !== 'pnyx' && agentActor({ actor })

// The exact text Hydra receives, so its transcript copy of a report is known by identity, never by markup.
export function hydraDelivery({ message }: { message: Pick<HydraMessage, 'id' | 'actor' | 'task' | 'kind' | 'text' | 'details' | 'context'> }) {
  const said = [
    message.text,
    message.details,
    message.context,
  ].filter(Boolean).join('\n\n')

  if (!reportActor({ actor: message.actor })) {
    return said
  }

  // A report cannot close its own envelope, or what follows it would reach Hydra outside it.
  const body = said.replace(
    /<\/pnyx-report/gi,
    '<\\/pnyx-report',
  )
  const quoted = ({ value }: { value: string }) => `"${value.replaceAll(
    '"',
    '&quot;',
  )}"`
  const task = message.task ? ` task=${quoted({ value: message.task })}` : ''
  const kind = message.kind ? ` kind=${quoted({ value: message.kind })}` : ''

  return `<pnyx-report from=${quoted({ value: message.actor })}${task}${kind} message=${quoted({ value: message.id })}>\n${body}\n</pnyx-report>`
}

// Hydra is a session the Pnyx server runs, not a Firstmate home or an outside agent.
export function hostedHydra({ state }: { state: HydraState }): boolean {
  return hydraConfig({ state }).hydra.kind !== 'firstmate' && state.cards[HYDRA_CARD]?.agent?.host === 'pnyx'
}

// Pnyx runs this Hydra's agent, or starts it on the next message: not a Firstmate home or an outside agent.
export function pnyxRunsHydra({ state }: { state: HydraState }): boolean {
  const agent = state.cards[HYDRA_CARD]?.agent
  const runsHere = !agent || agent.host === 'pnyx'

  return hydraConfig({ state }).hydra.kind !== 'firstmate' && runsHere
}

// The mode a hosted Hydra's session runs in, once it matches the composer's; none mid-switch.
export function hydraMode({ state }: { state: HydraState }): string | undefined {
  const running = state.cards[HYDRA_CARD]?.settings?.mode
  const chosen = hydraConfig({ state }).hydra.agent
  const settled = !chosen || chosen.mode === running

  return hostedHydra({ state }) && settled ? running : undefined
}

// Codex's never runs with the same full access as Bypass permissions.
export function hydraBypasses({ state }: { state: HydraState }): boolean {
  const mode = hydraMode({ state })
  const codexNever = mode === 'never' && state.cards[HYDRA_CARD]?.agent?.provider === 'codex'

  return mode === 'bypassPermissions' || codexNever
}

// Pnyx wakes a task's worker with news on its open pull request; a task whose worker ended, or that never had one, leaves it unwatched.
export function unwatchedPullRequests({ card }: { card: Card }): Link[] {
  if (card.sessionIds?.length && !card.stoppedAt) {
    return []
  }

  return card.links.filter(l => l.kind === 'github_pr' && l.state !== 'merged' && l.state !== 'closed')
}
