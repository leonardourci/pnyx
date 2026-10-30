import type { HelperUsageTotal } from '#routine-helper/state.ts'
import type { AgentRef, AgentSettings, PermissionRequest } from './model.ts'

export type PermissionDecision = ({ behavior: 'allow' } & Pick<PermissionRequest, 'answers' | 'values'>) | {
  behavior: 'deny'
  message: string
}
export type HostedText = {
  type: 'text'
  id: string
  text: string
  append?: boolean
}
export type PlanWindow = {
  label: string
  used: number
  resetsAt?: string
}
// What the session knows about its own size and spend; any field may be unknown.
export type HostedUsage = {
  type: 'usage'
  used?: number
  inputTokens?: number
  window?: number
  cost?: number
  plan?: string
  // Plan windows the agent reported itself, by label; a later report replaces the same label.
  limits?: PlanWindow[]
}
// What `hydra usage` answers: the session's own numbers and its account's plan windows.
export type HydraUsage = Omit<HostedUsage, 'type' | 'limits'> & {
  harness: 'claude' | 'codex'
  account?: string
  windows?: PlanWindow[]
  helper?: HelperUsageTotal
  combinedCost?: number
}

const named = ({ label }: PlanWindow) => label.toLowerCase()

// A window in `over` takes the place of the same label in `base`, whatever its case; new labels go last.
export const mergeWindows = ({
  base,
  over,
}: {
  base: PlanWindow[]
  over: PlanWindow[]
}): PlanWindow[] => [
  ...base.map(window => over.find(limit => named(limit) === named(window)) ?? window),
  ...over.filter(limit => !base.some(window => named(window) === named(limit))),
]
// A tool call the agent started, or its result arriving; while one runs the agent is busy, not quiet.
export type HostedTool = {
  tool?: string
  type: 'tool'
  id: string
  running: boolean
}
export type HostedThinking = {
  type: 'thinking'
  id: string
  running: boolean
}
export type HostedCompaction = {
  type: 'compaction'
  id: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  trigger: 'manual' | 'auto'
  error?: string
}
export type HostedImage = {
  path: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  digest: string
}
export type HostedInput = {
  id: string
  text: string
  images: HostedImage[]
}
export type InputReceipt = {
  inputId: string
  phase: 'queued' | 'taken' | 'confirmed' | 'carried' | 'settled' | 'unknown'
  turn?: string
}
// Submitted means handed to the SDK callback or native pipe, not acknowledged by the model.
export type AnswerReceipt = {
  answerId: string
  permission: string
  phase: 'received' | 'submitted' | 'aborted' | 'failed' | 'unknown'
}
export type NativePermission = {
  id: string
  tool: string
  input: Record<string, unknown>
  description?: string
} & Pick<PermissionRequest, 'questions' | 'form'>
export type NativeWork = {
  runningTurns: string[]
  runningTools: string[]
  unsettledInputs: string[]
  pendingControls: string[]
  queue: {
    knowledge: 'known'
    count: number
  } | { knowledge: 'unknown' }
  background: {
    knowledge: 'known'
    tasks: {
      id: string
      type: string
    }[]
  } | {
    knowledge: 'unknown'
    reason: string
  }
}
export type TurnOutcome = {
  turn: string
  inputIds: string[]
  status: 'completed' | 'interrupted' | 'failed'
  at: string
  assistant: {
    id: string
    text: string
  }[]
  result?: string
  structured?: unknown
  usage?: Omit<HostedUsage, 'type'>
  error?: string
}
export type HostedFact = {
  type: 'input'
  receipt: InputReceipt
} | {
  type: 'permission'
  request: NativePermission
} | {
  type: 'answer'
  receipt: AnswerReceipt
} | {
  type: 'permission-ended'
  id: string
} | {
  type: 'turn-ended'
  outcome: TurnOutcome
} | {
  type: 'ended'
  reason: 'closed' | 'failed'
  error?: string
}
// carried: the message the agent took last, mid-turn, opens its next turn instead of joining this one.
export type HostedEvent = 'working' | 'finished' | 'carried' | HostedText | {
  type: 'structured'
  value: unknown
} | HostedUsage | HostedTool | HostedThinking | HostedCompaction | HostedFact | {
  type: 'work'
  work: NativeWork
}
export type AskPermission = ({
  id,
  tool,
  input,
  signal,
  description,
  questions,
  form,
}: {
  id: string
  tool: string
  input: Record<string, unknown>
  signal: AbortSignal
  description?: string
} & Pick<PermissionRequest, 'questions' | 'form'>) => Promise<PermissionDecision>

export interface HostedSession {
  accepted?({ id }: { id: string }): boolean
  permissionDelivery?({ permission }: { permission: string }): string | undefined
  remote?: true
  readOnly?: boolean
  incarnation?: string
  recovered?: boolean
  replayed?(): Promise<void>
  refreshContext?(): Promise<void>
  fact?(): {
    id: string
    at: string
  } | undefined
  applied?(): Promise<void>
  settle?({ through }?: { through?: string }): Promise<void>
  detach?(): void
  id: string
  path?: string
  run({
    input,
    permission,
    observe,
  }: {
    input: AsyncIterable<HostedInput>
    permission: AskPermission
    // Runs before bounded viewer queues. A failure reason stops the native owner.
    observe?({ event }: { event: HostedEvent }): string | void
  }): AsyncIterable<HostedEvent>
  // Returning from an attachment only removes that reader; close owns native shutdown.
  attach(): AsyncIterable<HostedEvent>
  snapshot(): {
    work: NativeWork
    permissions: NativePermission[]
    answers: AnswerReceipt[]
    outcome?: TurnOutcome
  }
  set({
    setting,
    value,
  }: {
    setting: string
    value: string
  }): Promise<void>
  // Ends the running turn early; the session stays open for the next message.
  interrupt(): Promise<void>
  commands?(): Promise<{
    name: string
    description: string
    builtin?: boolean
  }[]>
  close(): void | Promise<void>
}

export interface ModelOption {
  value: string
  label: string
  resolvedModel?: string
  isDefault?: boolean
  // The effort and permission mode the harness runs this model with when none is chosen.
  defaultEffort?: string
  defaultMode?: string
}

// The model names a catalog answers to: each option and the model it resolves to.
export const modelIds = ({ models }: { models: ModelOption[] }) =>
  models.flatMap(model => [
    model.value,
    ...(model.resolvedModel ? [model.resolvedModel] : []),
  ])

export interface Provider {
  canOpen?(): boolean
  remote?: true
  owns?({ agent }: { agent: AgentRef }): boolean
  compact?: true
  // The harness's own list, the same in every folder: a model's defaultEffort is its own and defaultMode is unset.
  models({
    cwd,
    env,
  }: {
    cwd: string
    env: NodeJS.ProcessEnv
  }): Promise<ModelOption[]>
  // The list with the effort and permission mode the folder's settings start a session with.
  defaults({
    cwd,
    env,
    models,
  }: {
    cwd: string
    env: NodeJS.ProcessEnv
    models: ModelOption[]
  }): Promise<ModelOption[]>
  open({
    cwd,
    agent,
    settings,
    env,
    signal,
    instructions,
    outputSchema,
    allow,
    context,
    ownProcess,
    reattachOnly,
  }: {
    cwd: string
    // Reconcile retained facts without admitting a replacement native session.
    reattach?: true
    instructions?: string
    outputSchema?: Record<string, unknown>
    // Live state the session gets when it starts or resumes and again after each compaction.
    context?(): string
    // Commands the session runs without asking, such as Pnyx's own CLI for Hydra.
    allow?: string[]
    agent?: AgentRef
    settings: AgentSettings
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    ownProcess?({ pid }: { pid: number }): void
    reattachOnly?: boolean
  }): Promise<HostedSession>
}
