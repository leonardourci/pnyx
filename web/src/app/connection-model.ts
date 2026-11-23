import type { createThreadReceiver } from '#titan/thread-receive.ts'
import type { TaskSpend } from '#workers/task-spend.ts'
import type { AgentUsage } from '#workers/provider.ts'
import type { TitanSummary } from '#app/server-hydras.ts'
import type { CurrentAction } from '#titan/calls.ts'
import type { LatestMessage,ThreadPage } from '#titan/transcripts-read.ts'
import type { TitanQueue } from '#titan/wakes.ts'
import { createPendingResource } from '#web-shared/pending-intents.ts'
import type { Command,Receipt } from './connection.ts'
import { type TitanResource } from './pending-state.ts'
import type { createPendingTurns } from '#web-workers/pending-turns.ts'

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
  resource: TitanResource
  turns: ReturnType<typeof createPendingTurns>
  hasSnapshot: boolean
  ready: boolean
  expectedSeq?: number
  subscribed: boolean
  subscription: string | null
  // The cards the tab opened, sent with each subscribe so the server sends their live activity.
  page?: string[]
  failed: boolean
  restoredSaves: boolean
  error: string
  loadError: string
  subscriptionTimer?: ReturnType<typeof setTimeout>
  subscriptionAttempt: number
  readonly thread: ThreadPage | null
  threads: ReturnType<typeof createThreadReceiver>
  queue: TitanQueue
  spend: Record<string, TaskSpend>
  usage: Record<string, AgentUsage>
  latest: Record<string, LatestMessage>
  actions: Record<string, CurrentAction>
  command: Command
  leases: number
  creation?: Creation
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
  completion?: Promise<Receipt>
  checking?: boolean
  unconfirmed(): void
  timer?: ReturnType<typeof setTimeout>
  resolve({ receipt }: { receipt: Receipt }): void
  reject({ error }: { error: Error }): void
}

export type TitanListResource = ReturnType<
  typeof createPendingResource<TitanSummary[], TitanSummary>
>
