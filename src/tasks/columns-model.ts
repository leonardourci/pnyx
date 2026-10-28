export const COLUMNS = [
  'queued',
  'in_progress',
  'needs_you',
  'parked',
  'done',
] as const

// Column ids earlier versions wrote; old logs still name them until the Hydra moves onto the defaults.
export const LEGACY_IN_PROGRESS = 'workers_on_it'

export const LEGACY_COLUMNS = [
  LEGACY_IN_PROGRESS,
  'review',
] as const

export type Column = (typeof COLUMNS)[number] | (typeof LEGACY_COLUMNS)[number] | `custom:${string}`

export interface HydraColumn {
  id: Column
  title: string
  description?: string
  rule?: ColumnRule
  // Roles survive a rename. A task created in a role's column starts with its status,
  // and a card whose column is deleted falls back to the parked one.
  role?: (typeof COLUMNS)[number] | typeof LEGACY_IN_PROGRESS
}

export const CARD_FACTS = [
  'worker:none',
  'worker:working',
  'worker:checks',
  'worker:blocked',
  'worker:hydra',
  'worker:paused',
  'worker:ended',
  'owner-question',
  'held',
  'pr:none',
  'pr:draft',
  'pr:open',
  'pr:pending',
  'pr:green',
  'pr:red',
  'pr:merged',
  'pr:closed',
  'kind:build',
  'kind:investigation',
  'done',
  'reminder-due',
  'queued',
] as const

export type CardFact = (typeof CARD_FACTS)[number]

export type ColumnCondition = CardFact | `!${CardFact}`

export type ColumnRule = ColumnCondition[][]
