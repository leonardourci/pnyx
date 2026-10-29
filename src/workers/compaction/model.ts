import type { EventBase } from '#store/events.ts'
import type { AgentConfig } from '#workers/model.ts'

export interface Compaction {
  id: string
  session: string
  trigger: 'manual' | 'auto'
  state: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: string
  endedAt?: string
  error?: string
}

export interface CompactInput {
  id: string
  text: string
  original?: string
  actor: string
  route: 'hydra' | 'steering' | 'direct'
  accepted?: boolean
  agent?: AgentConfig
  at: string
}

export interface BuiltinCommand {
  command: string
  description: string
  source: string
  kind: 'command'
}

export interface CompactionState {
  catalogs?: Record<string, BuiltinCommand[]>

  operations: Compaction[]
  inputs: CompactInput[]
  priority?: string
  commentEpoch?: string
  commentSession?: string
  taughtEpoch?: string
  commentMessage?: string
}

export type CompactionChange =
  | {
    kind: 'catalog'
    key: string
    commands: BuiltinCommand[]
  }
  | {
    kind: 'status'
    operation: Compaction
  }
  | {
    kind: 'held'
    input: CompactInput
  }
  | {
    kind: 'taken'
    id: string
  }
  | {
    kind: 'priority'
    id: string
  }
  | {
    kind: 'comments'
    epoch: string
    message?: string
  }

export type CompactionEvent = EventBase & {
  type: 'session.compaction'
  data: CompactionChange
}
