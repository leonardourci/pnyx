import type { Card } from '../tasks/model.ts'
import type { AgentConfig, AgentSettings } from '../core/model.ts'
import type { ModelOption, HydraUsage, HostedSession } from '../server/provider.ts'
import type { DispatchChoice } from '../dispatch/select.ts'
import type { HydraState, HydraEvent } from './model.ts'
import { inbox, type HydraQueue } from './host.ts'
import type { CurrentAction } from '../thread/calls.ts'
import type { ThreadPage } from '../thread/read.ts'
import { liveReplies } from '../server/streaming.ts'

export interface Host {
  hydraId: string
  catalogCommands({
    card,
    provider,
  }: {
    card: Card
    provider?: string
  }): Promise<{
    command: string
    description: string
    source: string
    kind: 'command'
    unavailable?: string
  }[]>
  models({ harness }: { harness: 'claude' | 'codex' }): Promise<ModelOption[]>
  hydra({
    text,
    actor,
    id,
  }: {
    text: string
    actor: string
    id: string
    release?: boolean
    selected?: AgentConfig
  }): Promise<Record<string, unknown>>
  stop(): Promise<Record<string, unknown>>
  compact({
    card,
    sendNow,
  }: {
    card: string
    sendNow?: string
  }): Promise<Record<string, unknown>>
  usage(): Promise<HydraUsage | { usage: string }>
  start({
    task,
    prompt,
    folder,
    settings,
    id,
    actor,
    reason,
    replacement,
    dispatch,
  }: {
    task: string
    prompt: string
    folder?: string
    dispatch?: DispatchChoice
    replacement?: string
    settings: AgentSettings
    id: string
    actor: string
    reason?: string
  }): Promise<Record<string, unknown>>
  continue({
    task,
    id,
    actor,
    reason,
    check,
  }: {
    task: string
    id: string
    actor: string
    reason?: string
    check?: boolean
  }): Record<string, unknown>
  send({
    card,
    text,
    actor,
  }: {
    card: string
    text: string
    actor: string
    steering?: string
    attempt?: string
    direct?: boolean
    inputId?: string
  }): {
    deferred?: boolean
    queued?: boolean
  } | void
  set({
    card,
    setting,
    value,
    actor,
  }: {
    card: string
    setting: string
    value: string
    actor: string
  }): Promise<void>
  permission({
    task,
    request,
    choice,
    answer,
    actor,
    reason,
    details,
  }: {
    task: string
    request: string
    choice: 'allow' | 'deny'
    answer?: unknown
    actor: string
    reason?: string
    details?: string
  }): Record<string, unknown>
  reconcile({ state }: { state: HydraState }): void
  // Queues a check turn for a hosted Hydra once a change it tracks lands at seq on that card.
  wake({
    seq,
    card,
    reasons,
    event,
  }: {
    seq: number
    card: string
    reasons: string[]
    event?: HydraEvent
  }): void
  // Notes a change at seq that joins Hydra's next wake without queuing one, so that wake's cursor still covers it.
  unread({ seq }: { seq: number }): void
  // The changes waiting for Hydra's next check turn and the ones its running turn is reading.
  queue(): HydraQueue
  // Recovers hosted sessions and resumes a cut Hydra turn once.
  recover(): Promise<void>
  // A reply that never showed up in its session after its resends; Hydra hears of it once.
  unconfirmed({
    card,
    reply,
    text,
  }: {
    card: string
    reply: string
    text: string
  }): void
  action({
    card,
    action,
  }: {
    card: Card
    action: CurrentAction | null
  }): CurrentAction | null
  thread({
    card,
    page,
  }: {
    card: Card
    page: ThreadPage
  }): ThreadPage
  close(): void
}

export interface Live {
  input: ReturnType<typeof inbox>
  replies: ReturnType<typeof liveReplies>
  // The provider may still be loading when the first message arrives.
  session?: HostedSession
  activity: string
  steering: Set<string>
  task: string
  generation?: number
  replaced?: boolean
  // When its latest message went in, so a turn that has not written yet is not read as quiet.
  sentAt?: number
  // A setting this process could not take: it is replaced once its turn is over.
  stale?: boolean
  // The owner stopped the running turn, so a new message waits for it to end.
  stopping?: boolean
  idle?: ReturnType<typeof setTimeout>
  thinking: Set<string>
  // The tool calls running now, by id, with when each started.
  tools: Map<string, number>
}
