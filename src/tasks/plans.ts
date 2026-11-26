import { taskRank } from './order.ts'
import { randomUUID } from 'node:crypto'
import type { Decision, TitanState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { explained } from '#app/cli-support.ts'
import { hydraEvent } from '#titan/titan.ts'
import { TitanError, inField } from '#store/errors.ts'
import { canonical } from '#store/paths.ts'
import { taskProject } from '#projects/read.ts'
import { findCard } from './push-rules.ts'
import { taskBrief, taskIntent, type TaskCreated } from './cli.ts'
import { ownerAsk } from './owner-ask.ts'
import { decideDependencies } from './dependency-decisions.ts'
import { decideHold } from './holds.ts'
import { isManagedTask } from './select.ts'

export type TaskOperation = { reason?: string } & (
  | {
    op: 'task.create'
    as?: string
    key?: string
    title: string
    project?: string
    brief?: string
    intent?: string
    folder?: string
    hold?: boolean
    noStart?: boolean
    parent?: string
    before?: string
    ask?: string
    message?: string
  }
  | {
    op: 'task.brief'
    task: string
    brief?: string
    intent?: string
  }
  | {
    op: 'task.owner-ask'
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
  cardId,
}: {
  state: TitanState
  operation: TaskOperation
  meta: Meta
  titanId: string
  cardId?: string
}): Decision {
  if ([
    'task.create',
    'task.brief',
    'task.owner-ask',
  ].includes(operation.op)) {
    inField({
      field: 'reason',
      read: () => explained({ meta }),
    })
  }

  if (operation.op === 'task.create') {
    if (operation.message && !operation.ask) {
      throw new TitanError({
        message: 'message requires ask',
        field: 'message',
        code: 'VALIDATION_ERROR',
      })
    }

    const title = operation.title.trim()

    if (!title) {
      throw new TitanError({
        message: 'title must be a non-empty string',
        field: 'title',
        code: 'VALIDATION_ERROR',
      })
    }

    const key = operation.key ?? `task:${meta.id ?? randomUUID()}`

    if (key.startsWith('$')) {
      throw new TitanError({
        message: 'task keys beginning with $ are reserved',
        field: 'key',
        code: 'VALIDATION_ERROR',
      })
    }

    if (state.keys[key]) {
      throw new TitanError({
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

    if (parent?.parentId || (parent !== undefined && isManagedTask({ card: parent }))) {
      throw new TitanError({
        message: 'subtasks have one level under a task',
        field: 'parent',
        code: 'VALIDATION_ERROR',
      })
    }

    const createdId = cardId ?? `task-${randomUUID()}`
    const created: TaskCreated['data'] = {
      key,
      title,
    }

    if (operation.before) {
      created.rank = taskRank({
        state,
        card: {
          id: createdId,
          project,
          parentId: parent?.id,
          createdSeq: state.seq + 1,
        },
        before: operation.before,
      })
    }

    const folder = inField({
      field: 'folder',
      read: () => canonical({ path: operation.folder }),
    })
    const brief = inField({
      field: 'brief',
      read: () => taskBrief({ value: operation.brief }),
    })
    const intent = inField({
      field: 'intent',
      read: () => taskIntent({ value: operation.intent }),
    })
    const reason = meta.reason?.trim()

    if (operation.hold) {
      created.hold = reason || title
    }

    if (operation.noStart && reason) {
      created.unstarted = reason
    }

    if (project) {
      created.project = project
    }

    if (parent) {
      created.parentId = parent.id
    }

    if (folder) {
      created.folder = folder
    }

    if (brief !== undefined) {
      created.brief = brief
    }

    if (intent !== undefined) {
      created.intent = intent
    }

    if (operation.ask?.trim()) {
      try {
        created.ask = ownerAsk({
          state,
          task: createdId,
          text: operation.ask,
          message: operation.message,
          actor: meta.actor,
          at: meta.at,
        })
      } catch (error) {
        if (error instanceof TitanError && error.field === 'text') {
          error.field = 'ask'
        }

        throw error
      }
    }

    return hydraEvent({
      state,
      meta,
      cardId: createdId,
      change: {
        type: 'task.created',
        data: created,
      },
    })
  }

  if (operation.op === 'task.depend' || operation.op === 'task.undepend') {
    if (!operation.on.length) {
      throw new TitanError({
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

  const task = findCard({
    state,
    ref: operation.task,
  })

  if (isManagedTask({ card: task })) {
    throw new TitanError({
      message: 'choose a task',
      code: 'VALIDATION_ERROR',
    })
  }

  if (operation.op === 'task.brief') {
    const brief = inField({
      field: 'brief',
      read: () => taskBrief({ value: operation.brief }),
    })
    const intent = inField({
      field: 'intent',
      read: () => taskIntent({ value: operation.intent }),
    })

    if (brief === undefined && intent === undefined) {
      throw new TitanError({
        message: 'provide brief (empty text clears it) or intent',
        field: 'brief',
        code: 'VALIDATION_ERROR',
      })
    }

    const before = task.brief ?? ''
    const after = brief ?? before
    const rewritten = intent !== undefined && intent !== task.intent

    if (after === before && !rewritten) {
      return { skipped: 'unchanged' }
    }

    const data: {
      before: string
      after: string
      intent?: string
    } = {
      before,
      after,
    }

    if (rewritten) {
      data.intent = intent
    }

    return hydraEvent({
      state,
      meta,
      cardId: task.id,
      change: {
        type: 'task.brief',
        data,
      },
    })
  }

  const entry = ownerAsk({
    state,
    task: task.id,
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
      type: 'task.owner-ask',
      data: entry,
    },
  })
}
