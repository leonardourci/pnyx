import type { createThreadReceiver } from '#hydra/thread-receive.ts'
import type { TaskSpend } from '#workers/task-spend.ts'
import type { AgentUsage } from '#workers/provider.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import type { LatestMessage,ThreadPage } from '#hydra/transcripts-read.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import { createPendingResource } from '#web-shared/pending-intents.ts'
import type { Command,Receipt } from './connection.ts'
import type { watchHydra } from './hydra-views.ts'
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
  // The cards the tab opened, sent with each subscribe so the server sends their live activity.
  page?: string[]
  failed: boolean
  restoredSaves: boolean
  error: string
  loadError: string
  // The load error came from a Zero view, which reads again only once a retry builds it anew.
  readFailed?: boolean
  subscriptionTimer?: ReturnType<typeof setTimeout>
  subscriptionAttempt: number
  readonly thread: ThreadPage | null
  threads: ReturnType<typeof createThreadReceiver>
  queue: HydraQueue
  spend: Record<string, TaskSpend>
  usage: Record<string, AgentUsage>
  latest: Record<string, LatestMessage>
  actions: Record<string, CurrentAction>
  command: Command
  leases: number
  creation?: Creation
  views?: ReturnType<typeof watchHydra>
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
