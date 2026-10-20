import type { AgentRef, AgentSettings, PermissionRequest } from '../core/model.ts'

export type PermissionDecision = ({ behavior: 'allow' } & Pick<PermissionRequest, 'answers' | 'values'>) | { behavior: 'deny'; message: string }
export type HostedText = { type: 'text'; id: string; text: string; append?: boolean }
export type HostedEvent = 'working' | 'finished' | HostedText
export type AskPermission = ({ tool, input, signal, description, questions, form }: {
  tool: string
  input: Record<string, unknown>
  signal: AbortSignal
  description?: string
} & Pick<PermissionRequest, 'questions' | 'form'>) => Promise<PermissionDecision>

export interface HostedSession {
  id: string
  path?: string
  run({ input, permission }: {
    input: AsyncIterable<string>
    permission: AskPermission
  }): AsyncIterable<HostedEvent>
  set({ setting, value }: { setting: string; value: string }): Promise<void>
  close(): void
}

export interface ModelOption {
  value: string
  label: string
  resolvedModel?: string
  isDefault?: boolean
}

// The model names a catalog answers to: each option and the model it resolves to.
export const modelIds = ({ models }: { models: ModelOption[] }) =>
  models.flatMap(model => [model.value, ...(model.resolvedModel ? [model.resolvedModel] : [])])

export interface Provider {
  models({ cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ModelOption[]>
  open({ cwd, agent, settings, env, signal, instructions, allow }: {
    cwd: string
    instructions?: string
    // Commands the session runs without asking, such as Pnyx's own CLI for Hydra.
    allow?: string[]
    agent?: AgentRef
    settings: AgentSettings
    env: NodeJS.ProcessEnv
    signal: AbortSignal
  }): Promise<HostedSession>
}
