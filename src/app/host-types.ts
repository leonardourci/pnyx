import type { Card } from '#tasks/model.ts'
import type { AgentConfig, AgentSettings, AgentRef } from '#workers/model.ts'
import type { AgentUsage, UsageReading, ModelOption, HostedSession } from '#workers/provider.ts'
import type { DispatchChoice } from '#workers/dispatch.ts'
import type { TitanState, TitanEvent } from './model.ts'
import { inbox } from '#titan/update-queue.ts'
import type { TitanQueue } from '#titan/wakes.ts'
import type { CurrentAction } from '#titan/calls.ts'
import type { ThreadPage } from '#titan/transcripts-read.ts'
import { liveReplies } from '#workers/streaming.ts'
import type { RuntimeHealth } from '#diagnostics/health.ts'
import type { TaskSessionOwner } from './task-runtime.ts'

export type UsageInputs = {
  spend?: Record<string, import('#workers/task-spend.ts').TaskSpend>
  readings?: Record<string, UsageReading>
}

export interface Host {
  diagnostics(): Pick<RuntimeHealth, 'sessions' | 'helper'>
  hydraId: string
  // The reopen failure, when the grant could not reach its agent now.
  toolsChanged({ task }: { task: string }): Error | undefined
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
  models({
    harness,
    account,
    refresh,
  }: {
    harness: 'claude' | 'codex'
    account?: string
    // Asks the harness again even when this server already read its list.
    refresh?: boolean
  }): Promise<ModelOption[]>
  hydra({
    text,
    actor,
    id,
  }: {
    text: string
    original?: string
    actor: string
    id: string
    release?: boolean
    selected?: AgentConfig
    // False opens a new session with memory only, for an agent that reads the log itself.
    history?: boolean
    // The owner's messages the text lists, which Titan takes with this input.
    carried?: string[]
  }): Promise<Record<string, unknown>>
  agentExhausted({ agent }: { agent: AgentConfig }): Promise<boolean>
  changeAgent({
    id,
    choice,
  }: {
    id: string
    choice: 'inscribe' | 'compact' | 'neither'
  }): Promise<Record<string, unknown>>
  // Cancels an agent change that waits for the owner and sends its held messages again, so they reach the running agent or ask about the agent chosen now.
  resendHeldMessages(): Promise<void>
  stop({
    card,
    cancel }
  ?: {
    card?: string
    // One message the queued messages list for Titan, cancelled as Stop cancels them all.
    cancel?: string
  }): Promise<Record<string, unknown>>
  // Asks for an upgrade as /upgrade does and answers with the one to watch; now restarts a built one at once.
  upgrade({
    id,
    now,
  }: {
    id: string
    now?: boolean
  }): Promise<{ operation: import('#upgrade/model.ts').UpgradeOperation }>
  compact({
    card,
  }: {
    card: string
  }): Promise<Record<string, unknown>>
  usage({
    card,
    spend,
    readings }
  ?: { card?: string } & UsageInputs): Promise<AgentUsage | { usage: string }>
  refreshUsage({
    card,
    force,
  }: {
    card?: string
    force?: boolean
  }): Promise<{ refreshed: string }>
  usageViews({
    spend,
    readings,
  }: UsageInputs): Record<string, AgentUsage>
  start({
    task,
    prompt,
    folder,
    settings,
    id,
    actor,
    reason,
    replacement,
    inputId,
    dispatch,
    tools,
  }: {
    task: string
    prompt: string
    folder?: string
    dispatch?: DispatchChoice
    tools?: string[]
    replacement?: string
    inputId?: string
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
  }): Promise<Record<string, unknown>>
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
  }): Promise<{
    deferred?: boolean
    queued?: boolean
    // A direct input waiting for the provider to confirm it.
    pending?: boolean
  } | void>
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
  }): Promise<Record<string, unknown>>
  reconcile({ state }: { state: TitanState }): Promise<void>
  release({
    task,
    permanent,
  }: {
    task: string
    permanent?: boolean
  }): Promise<Record<string, unknown>>
  // Queues a check turn for a hosted Titan once a change it tracks lands at seq on that card.
  wake({
    seq,
    card,
    reasons,
    event,
  }: {
    seq: number
    card: string
    reasons: string[]
    event?: TitanEvent
  }): void
  // Notes a change at seq that joins Titan's next wake without queuing one, so that wake's cursor still covers it.
  unread({ seq }: { seq: number }): void
  // The changes waiting for Titan's next check turn and the ones its running turn is reading.
  queue(): TitanQueue
  // Recovers hosted sessions and resumes a cut Titan turn once.
  recover(): Promise<void>
  // A reply that never showed up in its session after its resends; Titan hears of it once.
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
  stopTools(): Promise<void>
  close(): void
}

export interface Live {
  owner?: TaskSessionOwner
  assignment?: Card & { agent: AgentRef }
  consumed?: Promise<void>
  input: ReturnType<typeof inbox>
  replies: ReturnType<typeof liveReplies>
  // The provider may still be loading when the first message arrives.
  session?: HostedSession
  activity: string
  steering: Set<string>
  // Steering inputs sent with their words, by input id; the agent taking one marks those messages read.
  delivered: Map<string, string[]>
  // Titan inputs that list the owner's messages, by input id; Titan taking one receives those messages.
  carried: Map<string, string[]>
  // Direct inputs whose reply waits for the provider's confirmation, by input id, and whether the agent took them.
  pendingDirect: Map<string, {
    card: string
    taken: boolean
  }>
  task: string
  generation?: number
  replaced?: boolean
  // When its latest message went in, so a turn that has not written yet is not read as quiet.
  sentAt?: number
  // A setting this process could not take: it is replaced once its turn is over.
  stale?: boolean
  toolResume?: string
  toolsRevision?: string
  // The owner stopped the running turn, so a new message waits for it to end.
  stopping?: boolean
  idle?: ReturnType<typeof setTimeout>
  thinking: Set<string>
  // The tool calls running now, by id, with when each started.
  tools: Map<string, number>
  toolNames: Map<string, string>
}
