import { readUpdateEvents } from '#tasks/updates-page.ts'
import { page } from './page-cli.ts'
import { apply } from '#app/apply/cli.ts'
import { AxiError } from 'axi-sdk-js'
import { guard, COMMON, parse, integer, HISTORY_LIMIT, HISTORY_MAX, WRITE, meta, required, commit, type Options, type Output, summarize } from './cli-support.ts'
import { taskCommand } from './task-cli.ts'
import { EVENT_TYPES, type HydraEvent } from './model.ts'
import { loadHydra } from './store.ts'
import { findCard } from '#tasks/push-rules.ts'
import { readEvents, scanEvents } from './event-log.ts'
import { historyTasks, updateTasks } from '#tasks/updates.ts'
import { decideUndo } from './undo.ts'
import { supervisedCommands } from '#routine-helper/commands.ts'
import { layout, view } from '#preferences/cli.ts'
import { owner } from '#memory/cli.ts'
import { settings } from '#settings/cli.ts'
import { harvest } from '#integrations/cli.ts'
import { link, outcome } from '#tasks/delivery/cli.ts'
import { columnCommandHandler, push, card, move, context } from '#tasks/cli.ts'
import { hydraCommandHandler } from '#hydra/cli.ts'
import { setup } from '#setup/cli.ts'
import { debug, logs } from '#diagnostics/cli.ts'

export const task = guard({ handler: ({ args }) => taskCommand({ args }) })

export const history = guard({
  handler: ({ args }) => {
    const options: Options = {
      ...COMMON,
      card: { type: 'string' },
      kind: { type: 'string' },
      workspace: { type: 'string' },
      before: { type: 'string' },
      limit: { type: 'string' },
      full: { type: 'boolean' },
      updates: { type: 'boolean' },
    }
    const {
      values,
      hydraId,
    } = parse({
      args,
      options,
      positionals: 0,
    })
    const limit = Math.min(
      integer({
        value: values.limit,
        flag: '--limit',
      }) ?? HISTORY_LIMIT,
      HISTORY_MAX,
    )
    const before = integer({
      value: values.before,
      flag: '--before',
    })
    const kind = values.kind as string | undefined
    const type = kind && (kind.includes('.') ? kind : `card.${kind}`)

    if (type && !(EVENT_TYPES as readonly string[]).includes(type)) {
      throw new AxiError(
        `unknown kind: ${kind}`,
        'VALIDATION_ERROR',
        ['Use one of pushed, moved, linked, outcome, replied, noted'],
      )
    }

    const ref = values.card as string | undefined
    const workspace = values.workspace as string | undefined
    // With --updates a card's index already holds just the events Updates shows.
    const keys = values.updates ? updateTasks : historyTasks
    // A historical card ID remains readable after the task has moved away.
    const listed = !!ref && readEvents({
      hydraId,
      cardId: ref,
      types: [
        'card.pushed',
        'task.created',
        'task.moved-in',
        'task.moved-out',
      ],
      limit: 1,
    }).length > 0
    const needsState = !!workspace || (!!ref && !listed)
    const state = needsState ? loadHydra({ hydraId }).state : undefined
    const cardId = ref && state ? findCard({
      state,
      ref,
    }).id : ref
    // An outcome keeps the workspace it was recorded under; other events use the card's current one.
    const inWorkspace = ({ e }: { e: HydraEvent }) =>
      (e.type === 'card.outcome' ? e.data.card.workspace : state?.cards[e.cardId]?.workspace) === workspace

    const selection = {
      hydraId,
      cardId,
      types: type ? [type] : undefined,
      before,
    }
    let matches = 0
    const page: HydraEvent[] = []
    const exactSelection = !workspace && (!cardId || values.updates)

    if (exactSelection) {
      const read = values.updates ? readUpdateEvents({
        types: selection.types,
        hydraId,
        cardId,
        before,
        limit: limit + 1,
      })
        : readEvents({
          ...selection,
          descending: true,
          limit: limit + 1,
        })
      page.push(...read.filter(event => !type || event.type === type))
      matches = page.length
      page.splice(limit)
    } else {
      for (const event of scanEvents({
        ...selection,
        descending: true,
      })) {
        if (cardId && !keys({ event }).includes(cardId)) {
          continue
        }

        if (workspace && !inWorkspace({ e: event })) {
          continue
        }

        matches++

        if (page.length === limit) {
          break
        }

        page.push(event)
      }
    }

    if (page.length === 0) {
      return { events: 'none: no matching events' }
    }

    const out: Output = {
      count: `${page.length}${matches > limit ? ', more before' : ''}`,
      events: page.map(e => ({
        seq: e.seq,
        id: e.id,
        at: e.at,
        type: e.type,
        card: e.cardId,
        actor: e.actor,
        summary: summarize({ event: e }),
        ...(values.full ? {
          data: e.data,
          reason: e.reason,
          details: e.details,
        } : {}),
      })),
    }

    if (matches > limit) {
      const flags = [
        'card',
        'kind',
        'workspace',
        'limit',
        'hydra',
      ].flatMap(f => (values[f] ? [
        `--${f}`,
        String(values[f]),
      ] : []))
      out.help = [
        `Run \`pnyx-axi history ${[
          ...flags,
          ...values.updates ? ['--updates'] : [],
          '--before',
          String(page.at(-1)!.seq),
        ].join(' ')}\` for older events`,
      ]
    }

    return out
  },
})

export const undo = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: WRITE,
      positionals: 1,
    })
    const m = meta({ values })
    const id = required({
      value: positionals[0],
      what: 'event id',
    })
    const target = readEvents({
      hydraId,
      ids: [id],
    })[0]

    if (!target) {
      throw new AxiError(
        `event not found: ${id}`,
        'NOT_FOUND',
        ['Run `pnyx-axi history` to find event ids'],
      )
    }

    return commit(
      {
        hydraId,
        meta: m,
        intent: {
          type: target.type,
          card: target.cardId,
        },
        decide: ({
          state,
          meta: current,
        }) => decideUndo({
          state,
          target,
          meta: current,
        }),
      },
    )
  },
})

export const commands = supervisedCommands({
  commands: {
    debug,
    page,
    logs,
    apply,
    layout,
    column: columnCommandHandler,
    hydra: hydraCommandHandler,
    owner,
    settings,
    task,
    view,
    push,
    card,
    harvest,
    move,
    link,
    outcome,
    history,
    undo,
    setup,
    context,
  },
})
