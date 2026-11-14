import type { SourceNote } from '#tasks/model.ts'
import type { ChildProcess } from 'node:child_process'
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
export type UsageReading = Omit<HostedUsage, 'type'>
export type AgentUsage = {
  who: {
    provider: string
    icon: string
    model?: string
    account?: string
    plan?: string
  }
  context?: {
    used: number
    window?: number
    left?: number
    source: 'reported'
  }
  recorded: {
    tokens?: number
    cost?: number
    worker?: number
    hydra?: number
    unavailable: number
    sharedHydra: boolean
  }
  windows: PlanWindow[]
  unavailable?: string
  helper?: HelperUsageTotal
  combinedCost?: number
}
export interface RecordedUsage {
  at?: string
  tokens: number
  tasks: string[]
}
export interface TranscriptUsageReader {
  rows: RecordedUsage[]
  messages: Map<string, number>
  previousTotal: number
  tasks: string[]
  current: UsageReading
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
  unsupported?: true
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
  // refused: the provider rejected or cancelled this input before the agent received it.
  phase: 'queued' | 'taken' | 'confirmed' | 'carried' | 'settled' | 'refused' | 'unknown'
  turn?: string
  // When the harness took the input, by its own record; without it, the receipt's arrival is that moment.
  at?: string
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
  stoppedProcesses?: number[]
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
  toolsRevision?: string
  id: string
  path?: string
  run({
    input,
    permission,
    observe,
  }: {
    input: AsyncIterable<HostedInput>
    permission: AskPermission
    // Runs before bounded viewer queues. A failure reason stops the session.
    observe?({ event }: { event: HostedEvent }): string | void
  }): AsyncIterable<HostedEvent>
  // Returning from an attachment only removes that reader; close owns shutdown.
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
  // eslint-disable-next-line pnyx/object-params -- Optional control options preserve no-argument Stop callers.
  interrupt(options?: { cancelQueued?: boolean }): Promise<void>
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
  // The model has a Fast tier.
  fast?: true
}

// The model names a catalog answers to: each option and the model it resolves to.
export const modelIds = ({ models }: { models: ModelOption[] }) =>
  models.flatMap(model => [
    model.value,
    ...(model.resolvedModel ? [model.resolvedModel] : []),
  ])

// Whether the model an agent runs, or the harness default when it names none, has a Fast tier.
export const fastModel = ({
  models,
  model,
}: {
  models: ModelOption[]
  model?: string
}) => {
  const option = model && model !== 'default'
    ? models.find(option => option.value === model || option.resolvedModel === model)
    : models.find(option => option.isDefault || option.value === 'default') ?? models[0]

  return option?.fast === true
}

// Fast in a Hydra's composer reaches an agent only where its model has a Fast tier.
export async function hydraFastReaches({
  hydraFast,
  models,
  model,
}: {
  hydraFast?: boolean
  models(): Promise<ModelOption[]>
  model?: string
}): Promise<boolean> {
  if (!hydraFast) {
    return false
  }

  // A catalog that cannot load leaves the agent off Fast; it must not stop the run.
  const offered = await models().catch(() => [])

  return fastModel({
    models: offered,
    model,
  })
}

export interface Provider {
  toolCatalog({
    cwd,
    env,
  }: {
    cwd: string
    env: NodeJS.ProcessEnv
  }): Promise<string[]>
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
    capabilities,
    allow,
    context,
    spawned,
  }: {
    cwd: string
    instructions?: string
    outputSchema?: Record<string, unknown>
    capabilities?: string[]
    toolScope?: 'routine'
    // Live state the session gets when it starts or resumes and again after each compaction.
    context?({ compacted }: { compacted?: boolean }): Promise<string>
    // Commands the session runs without asking, such as Pnyx's own CLI for Hydra.
    allow?: string[]
    agent?: AgentRef
    settings: AgentSettings
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    // Each agent process the session starts, so the server can stop one an earlier server left behind.
    spawned?({ child }: { child: ChildProcess }): void
  }): Promise<HostedSession>
}

export interface TranscriptMessage {
  block?: number
  internal?: boolean
  // Pnyx wrote this input: it carried a worker header, as a worker's start prompt does.
  pnyx?: boolean
  at?: string
  text: string
}

export interface TranscriptTrace {
  // Original block positions keep thread entry IDs stable.
  index: number
  kind: 'tool' | 'thinking'
  role: string
  text: string
  call?: string
}

export interface TranscriptCall {
  id: string
  tool: string
  command?: string
  file?: string
  query?: string
  url?: string
  skill?: string
  description?: string
}

export type FoundSettings = Record<string, string | null>

export interface TranscriptRecord {
  final?: boolean
  digest?: string
  contextReset?: true
  at?: string
  role: string
  messages: TranscriptMessage[]
  traces: TranscriptTrace[]
  calls: TranscriptCall[]
  results: string[]
  notes: SourceNote[]
  settings?: FoundSettings
}

export type TranscriptReader = ({
  record,
  subagent,
}: {
  record: unknown
  subagent?: boolean
}) => TranscriptRecord | undefined
