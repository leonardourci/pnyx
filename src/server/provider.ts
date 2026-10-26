import type { AgentRef, AgentSettings, PermissionRequest } from '../core/model.ts'

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
// carried: the message the agent took last, mid-turn, opens its next turn instead of joining this one.
export type HostedEvent = 'working' | 'finished' | 'carried' | HostedText | HostedUsage | HostedTool | HostedThinking | HostedCompaction
export type AskPermission = ({
  tool,
  input,
  signal,
  description,
  questions,
  form,
}: {
  tool: string
  input: Record<string, unknown>
  signal: AbortSignal
  description?: string
} & Pick<PermissionRequest, 'questions' | 'form'>) => Promise<PermissionDecision>

export interface HostedSession {
  id: string
  path?: string
  run({
    input,
    permission,
  }: {
    input: AsyncIterable<string>
    permission: AskPermission
  }): AsyncIterable<HostedEvent>
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
  close(): void
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
    allow,
    context,
  }: {
    cwd: string
    instructions?: string
    // Live state the session gets when it starts or resumes and again after each compaction.
    context?(): string
    // Commands the session runs without asking, such as Pnyx's own CLI for Hydra.
    allow?: string[]
    agent?: AgentRef
    settings: AgentSettings
    env: NodeJS.ProcessEnv
    signal: AbortSignal
  }): Promise<HostedSession>
}
