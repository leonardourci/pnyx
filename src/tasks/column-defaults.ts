import type { COLUMNS, HydraColumn, ColumnCondition, ColumnRule } from './columns-model.ts'

const NO_OWNER: ColumnCondition[] = [
  '!owner-question',
  '!reminder-due',
]

const UNFINISHED: ColumnCondition[] = [
  ...NO_OWNER,
  '!done',
]

const ACTIVE: ColumnCondition[] = [
  ...UNFINISHED,
  '!held',
  '!queued',
]

const DEFAULT_COLUMN_RULES: Record<string, ColumnRule> = {
  queued: [
    [
      ...NO_OWNER,
      'held',
    ],
    [
      ...UNFINISHED,
      'queued',
    ],
    [
      ...ACTIVE,
      'worker:none',
    ],
  ],
  in_progress: [
    [
      ...ACTIVE,
      'worker:working',
    ],
    [
      ...ACTIVE,
      'worker:checks',
    ],
    [
      ...ACTIVE,
      'worker:blocked',
    ],
    [
      ...ACTIVE,
      'worker:hydra',
    ],
  ],
  needs_you: [
    ['owner-question'],
    ['reminder-due'],
  ],
  parked: [
    [
      ...ACTIVE,
      'worker:paused',
    ],
    [
      ...ACTIVE,
      'worker:ended',
    ],
  ],
  done: [
    [
      ...NO_OWNER,
      '!held',
      'done',
    ],
  ],
}

export function columnRule({ column }: { column: HydraColumn }): ColumnRule {
  return column.rule ?? DEFAULT_COLUMN_RULES[column.role ?? ''] ?? []
}

export type Role = (typeof COLUMNS)[number]

const ROLE_COLUMNS: HydraColumn[] = [
  {
    id: 'queued',
    title: 'Queued',
    role: 'queued',
    description: 'Work waiting for a worker to start it.',
  },
  {
    id: 'in_progress',
    title: 'In progress',
    role: 'in_progress',
    description: 'Work a live worker is carrying forward.',
  },
  {
    id: 'needs_you',
    title: 'Needs you',
    role: 'needs_you',
    description: 'Work that needs the owner to answer a question, grant permission or make a decision.',
  },
  {
    id: 'parked',
    title: 'Parked',
    role: 'parked',
    description: 'Work kept for later, without an agent currently taking it forward.',
  },
  {
    id: 'done',
    title: 'Done',
    role: 'done',
    description: 'Work whose result has been checked and is complete.',
  },
]

export const DEFAULT_COLUMNS = ROLE_COLUMNS.map(column => ({
  ...column,
  rule: structuredClone(columnRule({ column })),
}))
