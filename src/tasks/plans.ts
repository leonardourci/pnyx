import { randomUUID } from 'node:crypto'
import type { Decision, HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { explained } from '#app/cli-support.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HydraError, inField } from '#store/errors.ts'
import { canonical } from '#store/paths.ts'
import { taskProject } from '#projects/read.ts'
import { parseKind } from '#investigations/report.ts'
import { findCard } from './push-rules.ts'
import { taskBrief, untilTime, type TaskCreated } from './cli.ts'
import { ownerAsk } from './intent.ts'
import { declareTask } from './declarations.ts'
import { decideDependencies } from './dependency-decisions.ts'
import { decideHold } from './holds.ts'
import { refuseEarlyDone } from '#tasks/delivery/done.ts'

export type TaskOperation = { reason?: string } & (
  | {
    op: 'task.create'
    as?: string
    key?: string
    title: string
    project?: string
    brief?: string
    folder?: string
    kind?: string
    hold?: boolean
    parent?: string
    column?: string
    ask?: string
    message?: string
  }
  | {
    op: 'task.brief'
    task: string
    brief: string
  }
  | {
    op: 'task.intent'
    task: string
    text: string
    message?: string
  }
  | {
    op: 'task.depend'
    task: string
    on: string[]
  }
  | {
    op: 'task.undepend'
    task: string
    on: string[]
  }
  | {
    op: 'task.status'
    task: string
    status: string
    note?: string
    until?: string
    hold?: boolean
  }
  | {
    op: 'task.hold'
    task: string
    message?: string
  }
  | {
    op: 'task.release'
    task: string
    message?: string
  }
)

export function planTaskChange({
  state,
  operation,
  meta,
  hydraId,
  cardId,
}: {
  state: HydraState
  operation: TaskOperation
  meta: Meta
  hydraId: string
  cardId?: string
}): Decision {
  if ([
    'task.create',
    'task.brief',
    'task.intent',
  ].includes(operation.op)) {
    inField({
      field: 'reason',
      read: () => explained({ meta }),
    })
  }

  if (operation.op === 'task.create') {
    if (operation.message && !operation.ask) {
      throw new HydraError({
        message: 'message requires ask',
        field: 'message',
        code: 'VALIDATION_ERROR',
      })
    }

    const title = operation.title.trim()

    if (!title) {
      throw new HydraError({
        message: 'title must be a non-empty string',
        field: 'title',
        code: 'VALIDATION_ERROR',
      })
    }

    const key = operation.key ?? `task:${meta.id ?? randomUUID()}`

    if (key.startsWith('$')) {
      throw new HydraError({
        message: 'task keys beginning with $ are reserved',
        field: 'key',
        code: 'VALIDATION_ERROR',
      })
    }

    if (state.keys[key]) {
      throw new HydraError({
        message: `task key already exists: ${key}`,
        field: 'key',
        code: 'CONFLICT',
      })
    }

    const project = operation.project ? inField({
      field: 'project',
      read: () => taskProject({
        state,
        ref: operation.project!,
      }),
    }) : undefined
    const parent = operation.parent ? findCard({
      state,
      ref: operation.parent,
    }) : undefined

    if (parent?.parentId || parent?.automaticTask || parent?.id === HYDRA_CARD) {
      throw new HydraError({
        message: 'subtasks have one level under a task',
        field: 'parent',
        code: 'VALIDATION_ERROR',
      })
    }

    const columns = hydraConfig({
      state,
      id: hydraId,
    }).columns
    const selected = operation.column ? columns.find(column => column.id === operation.column
      || column.title === operation.column || column.role === operation.column) : undefined

    if (operation.column && !selected) {
      throw new HydraError({
        message: 'unknown Hydra column',
        field: 'column',
        code: 'VALIDATION_ERROR',
      })
    }

    const created: TaskCreated['data'] = {
      key,
      title,
    }
    const folder = inField({
      field: 'folder',
      read: () => canonical({ path: operation.folder }),
    })
    const brief = inField({
      field: 'brief',
      read: () => taskBrief({ value: operation.brief }),
    })
    const kind = inField({
      field: 'kind',
      read: () => parseKind({ value: operation.kind ?? 'build' }),
    })

    if (operation.hold) {
      created.hold = meta.reason?.trim() || title
    }

    if (project) {
      created.project = project
    }

    if (parent) {
      created.parentId = parent.id
    }

    if (selected) {
      created.column = selected.id
    }

    if (folder) {
      created.folder = folder
    }

    if (brief !== undefined) {
      created.brief = brief
    }

    if (kind === 'investigation') {
      created.kind = kind
    }

    if (operation.ask?.trim()) {
      try {
        created.ask = ownerAsk({
          state,
          text: operation.ask,
          message: operation.message,
          actor: meta.actor,
          at: meta.at,
        })
      } catch (error) {
        if (error instanceof HydraError && error.field === 'text') {
          error.field = 'ask'
        }

        throw error
      }
    }

    return hydraEvent({
      state,
      meta,
      cardId: cardId ?? `task-${randomUUID()}`,
      change: {
        type: 'task.created',
        data: created,
      },
    })
  }

  if (operation.op === 'task.depend' || operation.op === 'task.undepend') {
    if (!operation.on.length) {
      throw new HydraError({
        message: 'on must contain at least one task',
        code: 'VALIDATION_ERROR',
      })
    }

    return decideDependencies({
      state,
      ref: operation.task,
      prerequisites: operation.on,
      remove: operation.op === 'task.undepend',
      meta,
    })
  }

  if (operation.op === 'task.hold' || operation.op === 'task.release') {
    return decideHold({
      state,
      ref: operation.task,
      message: operation.message,
      release: operation.op === 'task.release',
      meta,
    })
  }

  if (operation.op === 'task.status') {
    if (operation.status === 'done') {
      refuseEarlyDone({
        state,
        card: findCard({
          state,
          ref: operation.task,
        }),
        hydraId,
      })
    }

    return declareTask({
      state,
      ref: operation.task,
      status: operation.status,
      note: operation.note ?? '',
      meta,
      until: inField({
        field: 'until',
        read: () => untilTime({
          until: operation.until,
          now: meta.at,
        }),
      }),
      hold: operation.hold,
    })
  }

  const task = findCard({
    state,
    ref: operation.task,
  })

  if (task.automaticTask || task.id === HYDRA_CARD) {
    throw new HydraError({
      message: 'choose a task',
      code: 'VALIDATION_ERROR',
    })
  }

  if (operation.op === 'task.brief') {
    const after = taskBrief({ value: operation.brief })!

    return after === (task.brief ?? '') ? { skipped: 'unchanged' }
      : hydraEvent({
        state,
        meta,
        cardId: task.id,
        change: {
          type: 'task.brief',
          data: {
            before: task.brief ?? '',
            after,
          },
        },
      })
  }

  const entry = ownerAsk({
    state,
    text: operation.text,
    message: operation.message,
    actor: meta.actor,
    at: meta.at,
  })
  const recorded = task.ask?.some(ask => ask.message === entry.message && ask.text === entry.text)

  if (entry.message && recorded) {
    return { skipped: 'unchanged' }
  }

  return hydraEvent({
    state,
    meta,
    cardId: task.id,
    change: {
      type: 'task.intent',
      data: entry,
    },
  })
}
