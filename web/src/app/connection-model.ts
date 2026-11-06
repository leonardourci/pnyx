import type { HydraSummary } from '#app/server-hydras.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import type { LatestMessage,ThreadPage } from '#hydra/transcripts-read.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import { createPendingResource } from '#web-shared/pending-intents.ts'
import type { Command,Receipt } from './connection.ts'
import { type HydraResource } from './pending-state.ts'

export interface Creation {
  attempt: string
  from: string
  name: string
  icon?: string
  refusal?: {
    message: string
    code: string
  }
}
export interface Scope {
  id: string
  identity: string
  viewKey: string
  resource: HydraResource
  hasSnapshot: boolean
  ready: boolean
  subscribed: boolean
  subscription: string | null
  failed: boolean
  restoredSaves: boolean
  error: string
  thread: ThreadPage | null
  queue: HydraQueue
  latest: Record<string, LatestMessage>
  actions: Record<string, CurrentAction>
  command: Command
  leases: number
  creation?: Creation
  persistTimer?: ReturnType<typeof setTimeout>
}
export interface Request {
  id: string
  scope: Scope
  name: string
  args: string[]
  optimistic: boolean
  dependencies: string[]
  retry: boolean
  sent: boolean
  creation?: string
  saveId?: string
  checking?: boolean
  unconfirmed(): void
  timer?: ReturnType<typeof setTimeout>
  resolve({ receipt }: { receipt: Receipt }): void
  reject({ error }: { error: Error }): void
}

export type HydraListResource = ReturnType<
  typeof createPendingResource<HydraSummary[], HydraSummary>
>
