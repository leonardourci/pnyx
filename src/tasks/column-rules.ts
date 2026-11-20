import { LEGACY_IN_PROGRESS, LEGACY_COLUMNS, type HydraColumn, type Column } from './columns-model.ts'
import type { Card } from './model.ts'
import type { HydraState, Decision } from '#app/model.ts'
import { DEFAULT_COLUMNS, type Role, migrateDefaultRule } from './column-defaults.ts'
import { cardFacts, placeCard } from './columns.ts'
import { isManagedTask } from './select.ts'
import { ownerGates } from './owner-gates.ts'
import type { Meta } from '#app/command-meta.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { validateColumnRule } from './columns.ts'
import { HydraError } from '#store/errors.ts'

const legacyColumn = ({ id }: { id: Column }) => LEGACY_COLUMNS.some(legacy => legacy === id)

// A column named by its id or its role.
export function columnByRef({
  columns,
  ref,
}: {
  columns: HydraColumn[]
  ref: string
}): HydraColumn | undefined {
  return columns.find(c => c.id === ref || c.role === ref)
}

// The column a new task names, which may also be its title.
export function taskColumn({
  columns,
  ref,
}: {
  columns: HydraColumn[]
  ref: string
}): HydraColumn | undefined {
  return columns.find(c => c.id === ref || c.title === ref || c.role === ref)
}

// The column a new task asks for: the queued column when it is held, else the one it names.
function heldPlacement({
  columns,
  column,
  held,
}: {
  columns: HydraColumn[]
  column?: Column
  held: boolean
}): Column | undefined {
  return held ? roleColumn({
    columns,
    role: 'queued',
  }) : column
}

// Where a new task lands: the column it asks for, else the queued column, else parked.
export function createdColumn({
  columns,
  column,
  held,
}: {
  columns: HydraColumn[]
  column?: Column
  held: boolean
}): Column {
  return heldPlacement({
    columns,
    column,
    held,
  }) ?? roleColumn({
    columns,
    role: 'queued',
  }) ?? 'parked'
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

  if (ownerGates({ card }).length) {
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

function withDefaultColumns({ columns }: { columns: HydraColumn[] }): HydraColumn[] {
  if (!columns.some(c => legacyColumn({ id: c.id }) || c.role === LEGACY_IN_PROGRESS)) {
    return columns
  }

  const own = columns.filter(c => !c.role && !legacyColumn({ id: c.id })
    && !DEFAULT_COLUMNS.some(d => d.id === c.id))

  return [
    ...DEFAULT_COLUMNS.map(d => structuredClone(columns.find(c => c.role === d.role) ?? d)),
    ...structuredClone(own),
  ]
}

// Upgrade untouched defaults while preserving owner rules and manual placements.
export function migrateColumns({
  state,
  meta,
}: {
  state: HydraState
  meta: Meta
}): Decision {
  const before = hydraConfig({ state }).columns
  const layout = withDefaultColumns({ columns: before })
  const updated = layout.map(column => migrateDefaultRule({ column }))
  const rulesChanged = updated.some((
    column,
    index,
  ) => column !== layout[index])
  const columns = rulesChanged ? updated : layout
  const manual = new Set(updated.filter((
    column,
    index,
  ) => column.rule?.length === 0 && layout[index]?.rule?.length).map(column => column.id))
  const fallback = fallbackColumn({ columns })
  const placements = Object.fromEntries(Object.values(state.cards)
    .flatMap(card => {
      if (manual.has(card.column)) {
        return []
      }

      const staleNeedsYou = columns.some(column => column.id === card.column && column.role === 'needs_you')
        && !ownerGates({ card }).length

      if (staleNeedsYou && !card.hidden && !isManagedTask({ card })) {
        const after = placeCard({
          card: cardFacts({
            card,
            state,
          }),
          columns,
        }) ?? fallback

        if (after !== card.column) {
          return [
            [
              card.id,
              {
                before: card.column,
                after,
              },
            ],
          ]
        }
      }

      if (columns.some(c => c.id === card.column)) {
        if (!rulesChanged || card.hidden || isManagedTask({ card })) {
          return []
        }

        const facts = cardFacts({
          card,
          state,
        })
        const previous = placeCard({
          card: facts,
          columns: before,
        })
        const after = placeCard({
          card: facts,
          columns,
        })

        if (!after || previous !== card.column || after === card.column) {
          return []
        }

        return [
          [
            card.id,
            {
              before: card.column,
              after,
            },
          ],
        ]
      }

      const role = statusRole({ card })

      const after = (role && roleColumn({
        columns,
        role,
      })) ?? fallback

      return [
        [
          card.id,
          {
            before: card.column,
            after,
          },
        ],
      ]
    }))

  if (columns === before && !Object.keys(placements).length) {
    return { skipped: 'unchanged' }
  }

  return hydraEvent({
    state,
    meta: {
      ...meta,
      reason: 'Updated the default Hydra columns and rules',
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
