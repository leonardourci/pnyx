import type { AgentRef, AgentSettings } from '../core/model.ts'

export type PermissionDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string }
export type AskPermission = ({ tool, input, signal, description }: {
  tool: string
  input: Record<string, unknown>
  signal: AbortSignal
  description?: string
}) => Promise<PermissionDecision>

export interface HostedSession {
  id: string
  path?: string
  run({ input, permission }: { input: AsyncIterable<string>; permission: AskPermission }): AsyncIterable<'working' | 'finished'>
  set({ setting, value }: { setting: string; value: string }): Promise<void>
  close(): void
}

export interface Provider {
  open({ cwd, agent, settings, env, signal, instructions }: {
    cwd: string
    instructions?: string
    agent?: AgentRef
    settings: AgentSettings
    env: NodeJS.ProcessEnv
    signal: AbortSignal
  }): Promise<HostedSession>
}
