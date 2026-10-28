import { LEGACY_IN_PROGRESS, LEGACY_COLUMNS, type HydraColumn, type Column } from './columns-model.ts'
import type { TaskStatus, Card } from './model.ts'
import type { HydraState, Decision } from '../app/model.ts'
import { DEFAULT_COLUMNS, type Role, columnRule } from './column-defaults.ts'
import { ownerGates } from './owner-gates.ts'
import type { Meta } from '../app/command-meta.ts'
import { hydraConfig } from '../hydra/config.ts'
import { hydraEvent } from '../hydra/hydra.ts'
import { validateColumnRule } from './columns.ts'
import { HydraError } from '../store/errors.ts'

// A task created in an older layout's Workers on it column still starts working.
export const ROLE_STATUS: Partial<Record<NonNullable<HydraColumn['role']>, TaskStatus>> = {
  in_progress: 'working',
  [LEGACY_IN_PROGRESS]: 'working',
  needs_you: 'needs_you',
  done: 'done',
  parked: 'paused',
}

const legacyColumn = ({ id }: { id: Column }) => LEGACY_COLUMNS.some(legacy => legacy === id)

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
