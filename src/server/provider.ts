import type { AgentRef, AgentSettings } from '../core/model.ts'

export type PermissionDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string }
export type HostedText = { type: 'text'; id: string; text: string; append?: boolean }
export type HostedEvent = 'working' | 'finished' | HostedText
export type AskPermission = ({ tool, input, signal, description }: {
  tool: string
  input: Record<string, unknown>
  signal: AbortSignal
  description?: string
}) => Promise<PermissionDecision>

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
