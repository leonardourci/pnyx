import { TitanError } from '#store/errors.ts'
import { randomUUID } from 'node:crypto'
import type { EventType } from '#app/model.ts'
import { commit, required, type Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { parseOperation, ApplyError, type Operation } from '#app/apply/schema.ts'
import { planTaskChange, type TaskOperation } from './plans.ts'
import { START_FLAGS } from '#workers/cli.ts'

const ACTION_FLAGS: Record<string, string[]> = {
  create: [
    'title',
    'project',
    'brief',
    'intent',
    'ask',
    'message',
    'key',
    'folder',
    'parent',
    'column',
    'before',
    'hold',
    'no-start',
  ],
  brief: [
    'brief',
    'intent',
  ],
  'owner-ask': [
    'text',
    'message',
  ],
  depend: ['on'],
  undepend: ['on'],
  hold: [],
  release: ['from-message'],
  parent: ['before'],
  arrange: ['before'],
  rename: [
    'title',
    'project',
  ],
}
const EVENT_TYPES: Record<TaskOperation['op'], EventType> = {
  'task.create': 'task.created',
  'task.brief': 'task.brief',
  'task.owner-ask': 'task.owner-ask',
  'task.depend': 'task.dependencies',
  'task.undepend': 'task.dependencies',
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
  const toolsOnly = [
    'grant',
    'revoke',
    'available',
  ].find(flag => values[flag] !== undefined)

  if (action !== 'tools' && toolsOnly) {
    throw new TitanError({
      message: `--${toolsOnly} is only valid for task tools`,
      code: 'VALIDATION_ERROR',
    })
  }

  if (action !== 'start' && action !== 'create' && Array.isArray(values.tool) && values.tool.length) {
    throw new TitanError({
      message: '--tool is only valid for task start and task create',
      code: 'VALIDATION_ERROR',
    })
  }

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

  const unstarted = [
    'no-start',
    'hold',
  ].find(flag => values[flag])

  if (action === 'create' && values.start && unstarted) {
    throw new TitanError({
      message: `--start sends the ask to a worker, and --${unstarted} leaves the task unstarted; choose one`,
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'create' && values.start) {
    allowed.push(
      'start',
      'harness',
      'account',
      'model',
      'effort',
    )
  }

  if (action === 'create' && !values.start) {
    allowed.push(
      'behind',
      'on',
      ...START_FLAGS,
    )
  }

  const extra = Object.keys(values).find(name => !allowed.includes(name))

  if (extra) {
    throw new TitanError({
      message: `unknown flag --${extra} for task ${action}`,
      code: 'VALIDATION_ERROR',
      help: [`Valid flags: ${allowed.map(name => `--${name}`).join(', ')}`],
    })
  }

  const count = action === 'create' ? 1 : action === 'parent' ? 3 : 2

  if (positionals.length > count) {
    throw new TitanError({
      message: `unexpected argument: ${positionals[count]}`,
      code: 'VALIDATION_ERROR',
    })
  }
}

export async function localTaskCommand({
  action,
  values,
  positionals,
  hydraId,
  meta,
}: {
  action?: string
  values: Record<string, unknown>
  positionals: string[]
  hydraId: string
  meta: Meta
}): Promise<Output | undefined> {
  if (!action || action === 'rename' || action === 'parent' || action === 'arrange' || !Object.hasOwn(
    ACTION_FLAGS,
    action,
  )) {
    return undefined
  }

  const input: Record<string, unknown> = { op: `task.${action}` }

  for (const field of ACTION_FLAGS[action]!) {
    if (values[field] !== undefined) {
      const names: Record<string, string> = {
        'from-message': 'message',
        'wait-for': 'waitFor',
        'ready-when': 'readyWhen',
        'no-start': 'noStart',
      }
      input[names[field] ?? field] = values[field]
    }
  }

  if (action !== 'create') {
    input.task = required({
      value: positionals[1],
      what: 'task id',
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
    throw new TitanError({
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
  const output = await commit({
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

  return output
}
