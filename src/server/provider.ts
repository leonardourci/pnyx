import type { AgentRef, AgentSettings } from '../core/model.ts'

export interface HostedSession {
  id: string
  path?: string
  run({ input }: { input: AsyncIterable<string> }): AsyncIterable<'working' | 'finished'>
  set({ setting, value }: { setting: string; value: string }): Promise<void>
  close(): void
}

export interface Provider {
  open({ cwd, agent, settings, env, signal }: {
    cwd: string
    agent?: AgentRef
    settings: AgentSettings
    env: NodeJS.ProcessEnv
    signal: AbortSignal
  }): Promise<HostedSession>
}
