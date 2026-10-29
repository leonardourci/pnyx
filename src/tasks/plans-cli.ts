import { HydraError } from '#store/errors.ts'
import { randomUUID } from 'node:crypto'
import type { EventType } from '#app/model.ts'
import { commit, required, withHelp, type Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { parseOperation, ApplyError, type Operation } from '#app/apply/schema.ts'
import { planTaskChange, type TaskOperation } from './plans.ts'

const ACTION_FLAGS: Record<string, string[]> = {
  create: [
    'title',
    'project',
    'brief',
    'ask',
    'message',
    'key',
    'folder',
    'parent',
    'column',
    'kind',
    'hold',
  ],
  brief: ['brief'],
  intent: [
    'text',
    'message',
  ],
  depend: ['on'],
  undepend: ['on'],
  status: [
    'note',
    'until',
    'hold',
  ],
  hold: [],
  release: ['from-message'],
  rename: [
    'title',
    'project',
  ],
}
const EVENT_TYPES: Record<TaskOperation['op'], EventType> = {
  'task.create': 'task.created',
  'task.brief': 'task.brief',
  'task.intent': 'task.intent',
  'task.depend': 'task.dependencies',
  'task.undepend': 'task.dependencies',
  'task.status': 'task.declared',
  'task.hold': 'task.held',
  'task.release': 'task.released',
}
const WRITE_FLAGS = [
  'hydra',
  'actor',
  'reason',
  'details',
  'event-id',
  'if-revision',
]

export function validateLocalTaskFlags({
  action,
  values,
  positionals,
}: {
  action?: string
  values: Record<string, unknown>
  positionals: string[]
}): void {
  if (!action || !Object.hasOwn(
    ACTION_FLAGS,
    action,
  )) {
    return
  }

  const allowed = [
    ...WRITE_FLAGS,
    ...ACTION_FLAGS[action]!,
  ]
  const extra = Object.keys(values).find(name => !allowed.includes(name))

  if (extra) {
    throw new HydraError({
      message: `unknown flag --${extra} for task ${action}`,
      code: 'VALIDATION_ERROR',
      help: [`Valid flags: ${allowed.map(name => `--${name}`).join(', ')}`],
    })
  }

  const count = action === 'create' ? 1 : action === 'status' ? 3 : 2

  if (positionals.length > count) {
    throw new HydraError({
      message: `unexpected argument: ${positionals[count]}`,
      code: 'VALIDATION_ERROR',
    })
  }
}

export function localTaskCommand({
  action,
  values,
  positionals,
  hydraId,
  meta,
}: {
  action?: string
  values: Record<string, string | boolean | undefined>
  positionals: string[]
  hydraId: string
  meta: Meta
}): Output | undefined {
  if (!action || action === 'rename' || !Object.hasOwn(
    ACTION_FLAGS,
    action,
  )) {
    return undefined
  }

  const input: Record<string, unknown> = { op: `task.${action}` }

  for (const field of ACTION_FLAGS[action]!) {
    if (values[field] !== undefined) {
      input[field === 'from-message' ? 'message' : field] = values[field]
    }
  }

  if (action !== 'create') {
    input.task = required({
      value: positionals[1],
      what: 'task id',
    })
  }

  if (action === 'status') {
    input.status = required({
      value: positionals[2],
      what: 'status',
    })
  }

  let operation: Operation

  try {
    operation = parseOperation({ value: input })
  } catch (error) {
    if (!(error instanceof ApplyError)) {
      throw error
    }

    const reasons = error.errors.map(issue => `--${issue.path.split('/').at(-1)}: ${issue.reason}`)
    throw new HydraError({
      message: reasons.join('; '),
      code: 'VALIDATION_ERROR',
    })
  }

  if (operation.op === 'link' || operation.op === 'outcome') {
    return undefined
  }

  if (operation.op === 'task.create' && operation.key === undefined) {
    operation.key = `task:${meta.id ?? randomUUID()}`
  }

  const card = operation.op === 'task.create' ? operation.key! : operation.task
  const output = commit({
    hydraId,
    meta,
    intent: {
      type: EVENT_TYPES[operation.op],
      card,
    },
    decide: ({
      state,
      meta: current,
    }) => planTaskChange({
      state,
      operation,
      meta: current,
      hydraId,
    }),
  })

  if (operation.op !== 'task.create') {
    return output
  }

  return withHelp({
    output,
    help: ({ output }) => {
      const id = (output.card as { id?: string } | undefined)?.id ?? '<id>'

      return [
        `Run \`pnyx-axi task start ${id} --hydra ${hydraId}\` to start a worker`,
        `Run \`pnyx-axi task show ${id} --hydra ${hydraId}\` for the task`,
      ]
    },
  })
}
