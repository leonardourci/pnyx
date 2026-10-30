import { AxiError } from 'axi-sdk-js'
import { asRecord } from '#app/command-validation.ts'
import type { TaskOperation } from '#tasks/plans.ts'
import type { DeliveryOperation } from '#tasks/delivery/plans.ts'

export type Operation = TaskOperation | DeliveryOperation

export interface ApplyIssue {
  operation: number | null
  path: string
  code: string
  reason: string
}

export class ApplyError extends AxiError {
  readonly errors: ApplyIssue[]
  constructor({
    errors,
    help = ['Run `pnyx-axi apply --help`'],
  }: {
    errors: ApplyIssue[]
    help?: string[]
  }) {
    super(
      'Apply validation failed; nothing written',
      'VALIDATION_ERROR',
      help,
    )
    this.errors = errors
  }
}

export interface ApplyDocument {
  version: 1
  expected?: { tasks: Record<string, number> }
  changes: Operation[]
}

type FieldType = 'text' | 'string' | 'boolean' | 'references'
interface OperationSchema {
  fields: Record<string, FieldType>
  required: string[]
}

export const OPERATION_SCHEMAS: Record<Operation['op'], OperationSchema> = {
  'task.create': {
    fields: {
      as: 'text',
      key: 'text',
      title: 'text',
      project: 'text',
      brief: 'string',
      intent: 'text',
      folder: 'text',
      kind: 'text',
      hold: 'boolean',
      parent: 'text',
      column: 'text',
      ask: 'text',
      message: 'text',
    },
    required: ['title'],
  },
  'task.brief': {
    fields: {
      task: 'text',
      brief: 'string',
      intent: 'text',
    },
    required: ['task'],
  },
  'task.owner-ask': {
    fields: {
      task: 'text',
      text: 'text',
      message: 'text',
    },
    required: [
      'task',
      'text',
    ],
  },
  'task.depend': {
    fields: {
      task: 'text',
      on: 'references',
    },
    required: [
      'task',
      'on',
    ],
  },
  'task.undepend': {
    fields: {
      task: 'text',
      on: 'references',
    },
    required: [
      'task',
      'on',
    ],
  },
  'task.status': {
    fields: {
      task: 'text',
      status: 'text',
      note: 'string',
      until: 'text',
      hold: 'boolean',
    },
    required: [
      'task',
      'status',
    ],
  },
  'task.hold': {
    fields: { task: 'text' },
    required: ['task'],
  },
  'task.release': {
    fields: {
      task: 'text',
      message: 'text',
    },
    required: [
      'task',
      'message',
    ],
  },
  link: {
    fields: {
      task: 'text',
      url: 'text',
      kind: 'text',
      number: 'text',
      title: 'string',
      state: 'text',
      remove: 'boolean',
    },
    required: [
      'task',
      'url',
    ],
  },
  outcome: {
    fields: {
      task: 'text',
      state: 'text',
      note: 'string',
      clear: 'boolean',
    },
    required: ['task'],
  },
}

export function parseOperation({
  value,
  index = 0,
}: {
  value: unknown
  index?: number
}): Operation {
  const errors: ApplyIssue[] = []
  const operation = asRecord({ value })
  const path = `/changes/${index}`

  const issue = ({
    field,
    reason,
  }: {
    field: string
    reason: string
  }) => {
    errors.push({
      operation: index,
      path: `${path}/${field}`,
      code: 'VALIDATION_ERROR',
      reason,
    })
  }

  if (!operation || typeof operation.op !== 'string' || !Object.hasOwn(
    OPERATION_SCHEMAS,
    operation.op,
  )) {
    issue({
      field: 'op',
      reason: `use one of ${Object.keys(OPERATION_SCHEMAS).join(', ')}`,
    })
    throw new ApplyError({ errors })
  }

  const schema = OPERATION_SCHEMAS[operation.op as Operation['op']]
  const fields: Record<string, FieldType> = {
    ...schema.fields,
    reason: 'text',
  }

  for (const field of Object.keys(operation)) {
    if (field !== 'op' && !Object.hasOwn(
      fields,
      field,
    )) {
      issue({
        field,
        reason: `unknown field for ${operation.op}`,
      })
    }
  }

  for (const field of schema.required) {
    if (operation[field] === undefined) {
      issue({
        field,
        reason: 'required field',
      })
    }
  }

  for (const [
    field,
    type,
  ] of Object.entries(fields)) {
    const entry = operation[field]

    if (entry === undefined) {
      continue
    }

    if (type === 'boolean' && typeof entry !== 'boolean') {
      issue({
        field,
        reason: 'must be a boolean',
      })
    } else if ((type === 'text' || type === 'string') && typeof entry !== 'string') {
      issue({
        field,
        reason: 'must be a string',
      })
    } else if (type === 'text' && typeof entry === 'string' && !entry.trim()) {
      issue({
        field,
        reason: 'must be a non-empty string',
      })
    } else if (type === 'references') {
      if (!Array.isArray(entry) || !entry.length) {
        issue({
          field,
          reason: 'must be a non-empty array of task references',
        })
      } else {
        entry.forEach((
          reference,
          item,
        ) => {
          if (typeof reference !== 'string' || !reference.trim()) {
            issue({
              field: `${field}/${item}`,
              reason: 'must be a non-empty task reference',
            })
          }
        })
      }
    }
  }

  if (errors.length) {
    throw new ApplyError({ errors })
  }

  // The closed field schema above validates every member of this union.
  return operation as unknown as Operation
}

export function parseDocument({ value }: { value: unknown }): ApplyDocument {
  const document = asRecord({ value })
  const errors: ApplyIssue[] = []

  const issue = ({
    path,
    reason,
  }: {
    path: string
    reason: string
  }) => {
    errors.push({
      operation: null,
      path,
      code: 'VALIDATION_ERROR',
      reason,
    })
  }

  if (!document) {
    throw new ApplyError({
      errors: [
        {
          operation: null,
          path: '/',
          code: 'VALIDATION_ERROR',
          reason: 'must be an object',
        },
      ],
    })
  }

  for (const field of Object.keys(document)) {
    if (![
      'version',
      'expected',
      'changes',
    ].includes(field)) {
      issue({
        path: `/${field}`,
        reason: 'unknown field',
      })
    }
  }

  if (document.version !== 1) {
    issue({
      path: '/version',
      reason: 'must be 1',
    })
  }

  let expected: ApplyDocument['expected']

  if (document.expected !== undefined) {
    const revisions = asRecord({ value: document.expected })
    const tasks = asRecord({ value: revisions?.tasks })

    if (!revisions || Object.keys(revisions).some(field => field !== 'tasks') || !tasks) {
      issue({
        path: '/expected',
        reason: 'must contain only tasks, a map of task references to revisions',
      })
    } else {
      expected = { tasks: Object.create(null) }

      for (const [
        task,
        revision,
      ] of Object.entries(tasks)) {
        if (!task.trim() || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
          issue({
            path: `/expected/tasks/${task}`,
            reason: 'must name a task and a non-negative safe integer revision',
          })
        } else {
          expected.tasks[task] = revision
        }
      }
    }
  }

  if (!Array.isArray(document.changes) || !document.changes.length) {
    issue({
      path: '/changes',
      reason: 'must be a non-empty array',
    })
    throw new ApplyError({ errors })
  }

  const changes: Operation[] = []

  document.changes.forEach((
    change,
    index,
  ) => {
    try {
      changes.push(parseOperation({
        value: change,
        index,
      }))
    } catch (error) {
      if (!(error instanceof ApplyError)) {
        throw error
      }

      errors.push(...error.errors)
    }
  })

  if (errors.length) {
    throw new ApplyError({ errors })
  }

  return {
    version: 1,
    expected,
    changes,
  }
}
