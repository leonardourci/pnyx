import { taskRank } from '#tasks/order.ts'
import { TitanError } from '#store/errors.ts'
import type { TitanState } from '#app/model.ts'
import type { Card, TaskReminder } from '#tasks/model.ts'
import { reminderRepeat } from '#tasks/reminders.ts'
import type { AgentConfig } from '#workers/model.ts'
import { titanConfig } from '#titan/config.ts'
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
  state: TitanState
  edit: Edit
}): TitanState {
  const option = ({ flag }: { flag: string }) => argument({
    args,
    flag,
  })
  const config = titanConfig({ state })
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

  if (name === 'task' && action === 'hold' && card) {
    const id = option({ flag: '--event-id' })
    const reason = option({ flag: '--reason' })

    if (!id || !reason) {
      return state
    }

    return update({
      patch: {
        hold: {
          id,
          reason,
          actor: 'web',
          at: new Date().toISOString(),
        },
      },
    })
  }

  if (name === 'task' && action === 'create') {
    const event = option({ flag: '--event-id' })
    const title = option({ flag: '--title' })?.trim()
    const key = option({ flag: '--key' }) ?? `task:${event}`
    const parentRef = option({ flag: '--parent' })
    const parentId = parentRef ? state.keys[parentRef] ?? parentRef : undefined
    const missingParent = parentId && !state.cards[parentId]

    if (!event || !title || state.keys[key] || missingParent) {
      return state
    }

    const pending: Card = {
      id: key,
      key,
      title,
      titleSet: true,
      brief: option({ flag: '--brief' }),
      project: option({ flag: '--project' }),
      workspace: 'unassigned',
      tags: [],
      attention: [],
      links: [],
      sourceRefs: [],
      parentId,
      revision: 0,
      createdSeq: state.seq + 1,
      updatedSeq: 0,
      updatedAt: '',
    }

    const before = option({ flag: '--before' })

    if (before) {
      try {
        pending.rank = taskRank({
          state,
          card: pending,
          before,
        })
      } catch (error) {
        if (error instanceof TitanError) {
          return state
        }

        throw error
      }
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

  if (name === 'titan-agent') {
    const agent = JSON.parse(args[0] ?? '{}') as AgentConfig

    return {
      ...state,
      config: {
        ...config,
        titan: {
          ...config.titan,
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

  if (name === 'task' && card) {
    if (action === 'defer-question') {
      const question = card.asks?.find(ask => ask.id === args[2])
      const until = option({ flag: '--until' })

      if (!question || question.audience !== 'owner' || question.answered || question.closed || !until) {
        return state
      }

      const deferred = { ...question }
      delete deferred.deferredUntil
      delete deferred.deferredFromMessage

      if (until !== 'clear') {
        if (!Number.isFinite(Date.parse(until))) {
          return state
        }

        deferred.deferredUntil = until
      }

      const asks = card.asks?.map(ask => ask.id === question.id ? deferred : ask)

      return update({ patch: { asks } })
    }

    if (action === 'arrange') {
      return update({
        patch: {
          rank: taskRank({
            state,
            card,
            before: option({ flag: '--before' }),
          }),
        },
      })
    }

    if (action === 'parent') {
      const parentRef = args[2]

      if (parentRef === 'none') {
        return update({
          patch: {
            parentId: undefined,
            rank: taskRank({
              state,
              card: {
                ...card,
                parentId: undefined,
              },
              before: option({ flag: '--before' }),
            }),
          },
        })
      }

      const parent = state.cards[parentRef ?? ''] ?? state.cards[state.keys[parentRef ?? ''] ?? '']
      const hasChildren = Object.values(state.cards).some(child => child.parentId === card.id)

      if (!parent || parent.id === card.id || parent.parentId || hasChildren) {
        return state
      }

      return update({ patch: { parentId: parent.id } })
    }

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
      let reminder: TaskReminder | undefined

      if (args[2] !== 'clear') {
        const when = args[2] ?? ''
        reminder = {
          id: option({ flag: '--event-id' }) ?? 'pending',
          // The request boundary normalizes time once; pending edits may outlive it.
          at: when,
        }
        const repeat = reminderRepeat({
          state,
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

      return update({ patch: { reminder } })
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

  if (name === 'titan' && action === 'set') {
    const title = option({ flag: '--name' })
    const identity = option({ flag: '--identity' })
    const polis = option({ flag: '--polis' })

    return {
      ...state,
      config: {
        ...config,
        polis: polis ?? config.polis,
        ...(title ? { name: title } : {}),
        titan: {
          ...config.titan,
          ...(identity ? { id: identity } : {}),
        },
      },
    }
  }

  return state
}

export function currentRevision({
  state,
  edit,
}: {
  state: TitanState
  edit: Edit
}): string[] {
  const args = [...edit.args], index = args.indexOf('--if-revision')

  if (index >= 0) {
    const ref = args[1] ?? ''
    const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']
    args[index + 1] = String(edit.name === 'view' ? state.viewRevision ?? 0 : edit.name === 'titan' ? state.configRevision ?? 0 : card?.revision ?? 0)
  }

  return args
}
