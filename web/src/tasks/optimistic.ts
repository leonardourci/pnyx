import type { HydraState } from '../../../src/app/model.ts'
import type { Card } from '../../../src/tasks/model.ts'
import type { AgentConfig } from '../../../src/workers/model.ts'
import { hydraConfig } from '../../../src/core/hydra.ts'
import { columnCards, rankOf } from '../../../src/tasks/select.ts'
import { patchView } from '../../../src/preferences/view.ts'

export interface Edit {
  name: string
  args: string[]
}

export function argument({
  args,
  flag,
}: {
  args: string[]
  flag: string
}): string | undefined {
  const inline = args.find(value => value.startsWith(`${flag}=`))

  return inline ? inline.slice(flag.length + 1)
    : args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
}

export function optimisticState({
  state,
  edit: {
    name,
    args,
  },
}: {
  state: HydraState
  edit: Edit
}): HydraState {
  const option = ({ flag }: { flag: string }) => argument({
    args,
    flag,
  })
  const config = hydraConfig({ state })
  const [
    action,
    ref,
  ] = args
  const card = state.cards[ref ?? ''] ?? state.cards[state.keys[ref ?? ''] ?? '']
  const update = ({ patch }: { patch: Partial<NonNullable<typeof card>> }) => card
    ? {
      ...state,
      cards: {
        ...state.cards,
        [card.id]: {
          ...card,
          ...patch,
        },
      },
    } : state

  if (name === 'task' && action === 'create') {
    const event = option({ flag: '--event-id' })
    const title = option({ flag: '--title' })?.trim()
    const key = option({ flag: '--key' }) ?? `task:${event}`
    const columnRef = option({ flag: '--column' })
    const column = config.columns.find(column =>
      column.id === columnRef || column.role === columnRef)
      ?? config.columns.find(column => column.role === 'queued')
    const parentRef = option({ flag: '--parent' })
    const parentId = parentRef ? state.keys[parentRef] ?? parentRef : undefined

    if (!event || !title || !column || state.keys[key] || (parentId && !state.cards[parentId])) {
      return state
    }

    const first = columnCards({
      state,
      column: column.id,
    })[0]
    const pending: Card = {
      id: key,
      key,
      title,
      titleSet: true,
      workspace: 'unassigned',
      tags: [],
      attention: [],
      links: [],
      sourceRefs: [],
      tracking: 'declared',
      parentId,
      column: column.id,
      rank: first ? rankOf({ card: first }) - 1 : 0,
      revision: 0,
      createdSeq: 0,
      updatedSeq: 0,
      updatedAt: '',
    }

    return {
      ...state,
      cards: {
        ...state.cards,
        [key]: pending,
      },
      keys: {
        ...state.keys,
        [key]: key,
      },
    }
  }

  if (name === 'hydra-agent') {
    const agent = JSON.parse(args[0] ?? '{}') as AgentConfig

    return {
      ...state,
      config: {
        ...config,
        hydra: {
          ...config.hydra,
          agent,
        },
      },
    }
  }

  if (name === 'view' && action === 'set') {
    return {
      ...state,
      view: patchView({
        state,
        input: JSON.parse(option({ flag: '--json' }) ?? '{}'),
      }),
    }
  }

  if (name === 'move') {
    const moved = state.cards[action ?? ''] ?? state.cards[state.keys[action ?? ''] ?? '']

    const column = config.columns.find(c => c.id === ref)

    if (!moved || !column) {
      return state
    }

    const others = columnCards({
      state,
      column: column.id,
    }).filter(c => c.id !== moved.id)
    const before = option({ flag: '--before' })
    const at = before === undefined ? others.length
      : others.findIndex(c => c.id === before || c.key === before)

    if (at < 0) {
      return state
    }

    const next = others[at], previous = others[at - 1]
    const rank = next && previous ? (rankOf({ card: previous }) + rankOf({ card: next })) / 2
      : next ? rankOf({ card: next }) - 1
        : previous ? rankOf({ card: previous }) + 1 : rankOf({ card: moved })

    return {
      ...state,
      cards: {
        ...state.cards,
        [moved.id]: {
          ...moved,
          column: column.id,
          rank,
        },
      },
    }
  }

  if (name === 'task' && card) {
    if (action === 'rename') {
      const title = option({ flag: '--title' }), project = option({ flag: '--project' })

      return update({
        patch: {
          ...(title !== undefined ? {
            title,
            titleSet: true,
          } : {}),
          ...(project !== undefined ? { project: project || undefined } : {}),
        },
      })
    }

    if (action === 'hide' || action === 'unhide') {
      return update({ patch: { hidden: action === 'hide' } })
    }

    if (action === 'brief') {
      return update({ patch: { brief: option({ flag: '--brief' }) ?? '' } })
    }

    if (action === 'remind') {
      return update({
        patch: {
          reminder: args[2] === 'clear' ? undefined : {
            id: option({ flag: '--event-id' }) ?? 'pending',
            at: args[2] ?? '',
          },
        },
      })
    }

    if (action === 'hide-after') {
      return update({ patch: { doneAfterHours: args[2] === 'default' ? undefined : Number(args[2]) } })
    }
  }

  if (name === 'hydra' && action === 'set') {
    const title = option({ flag: '--name' })
    const identity = option({ flag: '--identity' }), hours = option({ flag: '--done-after-hours' })

    return {
      ...state,
      config: {
        ...config,
        ...(title ? { name: title } : {}),
        ...(hours !== undefined ? { doneAfterHours: Number(hours) } : {}),
        hydra: {
          ...config.hydra,
          ...(identity ? { id: identity } : {}),
        },
      },
    }
  }

  if (name === 'column' && [
    'create',
    'rename',
    'describe',
    'reorder',
    'delete',
  ].includes(action ?? '')) {
    let columns = config.columns.map(c => ({ ...c }))
    const selected = columns.find(c => c.id === ref || c.role === ref)

    if (action === 'create') {
      const id = option({ flag: '--id' }), title = option({ flag: '--title' })

      if (!id?.startsWith('custom:') || !title) {
        return state
      }

      columns = [
        ...columns.filter(c => c.id !== id),
        {
          id: `custom:${id.slice(7)}`,
          title,
        },
      ]
    } else if (!selected) {
      return state
    } else if (action === 'rename') {
      selected.title = option({ flag: '--title' }) ?? selected.title
    } else if (action === 'describe') {
      selected.description = option({ flag: '--description' }) ?? ''
    } else {
      columns = columns.filter(c => c.id !== selected.id)

      if (action === 'reorder') {
        const before = option({ flag: '--before' }), at = before ? columns.findIndex(c => c.id === before) : columns.length
        columns.splice(
          at < 0 ? columns.length : at,
          0,
          selected,
        )
      }
    }

    const fallback = columns.find(c => c.id === option({ flag: '--to' }))?.id ?? columns[0]?.id
    const cards = action === 'delete' && selected && fallback ? Object.fromEntries(Object.entries(state.cards).map(([
      id,
      card,
    ]) => [
      id,
      card.column === selected.id ? {
        ...card,
        column: fallback,
      } : card,
    ])) : state.cards

    return {
      ...state,
      cards,
      config: {
        ...config,
        columns,
      },
    }
  }

  return state
}

export function currentRevision({
  state,
  edit,
}: {
  state: HydraState
  edit: Edit
}): string[] {
  const args = [...edit.args], index = args.indexOf('--if-revision')

  if (index >= 0) {
    const ref = args[edit.name === 'move' ? 0 : 1] ?? ''
    const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']
    args[index + 1] = String(edit.name === 'view' ? state.viewRevision ?? 0 : [
      'column',
      'hydra',
    ].includes(edit.name) ? state.configRevision ?? 0 : card?.revision ?? 0)
  }

  return args
}

export function projectEdits({
  state,
  edits,
  invalid,
}: {
  state: HydraState
  edits: Edit[]
  invalid?({
    edit,
    error,
  }: {
    edit: Edit
    error: Error
  }): void
}): HydraState {
  return edits.reduce(
    (
      state,
      edit,
    ) => {
      try {
        return optimisticState({
          state,
          edit,
        })
      } catch (error) {
        invalid?.({
          edit,
          error: error instanceof Error ? error : new Error(String(error)),
        })

        return state
      }
    },
    state,
  )
}
