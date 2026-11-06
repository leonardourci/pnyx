import type { HydraState } from '#app/model.ts'
import type { HeadsDispatch, Candidate } from '#workers/dispatch-config.ts'
import type { AgentConfig, AgentSettings } from '#workers/model.ts'

export function hydraCandidate({
  state,
  dispatch,
}: {
  state: Pick<HydraState, 'config'>
  dispatch: HeadsDispatch
}): Candidate {
  return state.config?.hydra.agent ?? dispatch.rules.hydra?.candidates[0]
    ?? dispatch.default[0] ?? { harness: 'claude' }
}

// An agent choice as session settings; its harness and account choose the session rather than configure it.
export function agentSettings({ agent }: { agent: Partial<AgentConfig> }): AgentSettings {
  return Object.fromEntries(Object.entries(agent).filter(([
    key,
    value,
  ]) => key !== 'harness' && key !== 'account' && value !== undefined)
    .map(([
      key,
      value,
    ]) => [
      key,
      String(value),
    ]))
}
