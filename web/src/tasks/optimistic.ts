import { createBeforeRank } from '#tasks/create-placement.ts'
import type { HydraState } from '#app/model.ts'
import type { Card, TaskReminder } from '#tasks/model.ts'
import { clearReminder, reminderRepeat } from '#tasks/reminders.ts'
import { lifecycleMoves } from '#tasks/lifecycle.ts'
import { reminderTime } from '#tasks/time.ts'
import type { AgentConfig } from '#workers/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { columnCards, rankOf, rankWithin } from '#tasks/select.ts'
import { columnByRef, createdColumn, taskColumn } from '#tasks/column-rules.ts'
import { hideAfterHours } from '#tasks/retention-rules.ts'
import { patchView } from '#preferences/view.ts'

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
    const named = columnRef === undefined ? undefined : taskColumn({
      columns: config.columns,
      ref: columnRef,
    })
    const column = createdColumn({
      columns: config.columns,
      column: named?.id,
      held: args.includes('--hold'),
    })
    const parentRef = option({ flag: '--parent' })
    const parentId = parentRef ? state.keys[parentRef] ?? parentRef : undefined
    const unknownColumn = columnRef !== undefined && !named
    const missingParent = parentId && !state.cards[parentId]

    if (!event || !title || unknownColumn || state.keys[key] || missingParent) {
      return state
    }

    const before = option({ flag: '--before' })
    const first = columnCards({
      state,
      column,
    })[0]
    const top = first ? rankOf({ card: first }) - 1 : 0
    const rank = before ? createBeforeRank({
      state,
      column,
      before,
    }) : top
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
      column,
      rank,
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

    const column = columnByRef({
      columns: config.columns,
      ref: ref ?? '',
    })

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

    const rank = rankWithin({
      card: moved,
      others,
      at,
    })

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
      const restored = { ...card }
      clearReminder({ card: restored })
      let reminder: TaskReminder | undefined

      if (args[2] !== 'clear') {
        const when = args[2] ?? ''
        reminder = {
          id: option({ flag: '--event-id' }) ?? 'pending',
          at: reminderTime({
            when,
            now: new Date().toISOString(),
          }),
        }
        const repeat = reminderRepeat({
          card,
          when,
          every: option({ flag: '--every' }),
          until: option({ flag: '--until' }),
          question: option({ flag: '--question' }),
        })

        if (repeat) {
          reminder.repeat = repeat
        }
      }

      const changed = update({
        patch: {
          reminder,
          status: restored.status,
        },
      })
      const placement = lifecycleMoves({
        before: state,
        state: changed,
      })
        .find(move => move.cardId === card.id)

      if (!placement) {
        return changed
      }

      return optimisticState({
        state: changed,
        edit: {
          name: 'move',
          args: [
            card.id,
            placement.column,
          ],
        },
      })
    }

    if (action === 'hide-after') {
      const hours = hideAfterHours({ value: args[2] ?? '' })

      if (hours === undefined) {
        return state
      }

      // `default` clears the card's own hours, so it follows the shared setting again.
      const doneAfterHours = hours === null ? undefined : hours

      return update({ patch: { doneAfterHours } })
    }
  }

  if (name === 'hydra' && action === 'set') {
    const title = option({ flag: '--name' })
    const identity = option({ flag: '--identity' })

    return {
      ...state,
      config: {
        ...config,
        ...(title ? { name: title } : {}),
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
    const selected = columnByRef({
      columns,
      ref: ref ?? '',
    })

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
        const before = option({ flag: '--before' })
        const above = before ? columnByRef({
          columns,
          ref: before,
        }) : undefined

        // The server refuses a --before column it cannot find.
        if (before && !above) {
          return state
        }

        columns.splice(
          above ? columns.indexOf(above) : columns.length,
          0,
          selected,
        )
      }
    }

    const to = action === 'delete' ? option({ flag: '--to' }) : undefined
    const target = to ? columnByRef({
      columns,
      ref: to,
    }) : undefined

    // The server refuses a --to column it cannot find.
    if (to && !target) {
      return state
    }

    const fallback = target?.id ?? columns[0]?.id
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
