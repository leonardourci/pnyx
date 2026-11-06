import type { HydraState } from '#app/model.ts'
import type { HeadsDispatch, Candidate } from '#workers/dispatch-config.ts'
import type { AgentConfig, AgentSettings } from '#workers/model.ts'
import { DEFAULT_HARNESS, harnessOf } from '#workers/providers.ts'
import { HYDRA_CARD } from './identity.ts'

// The harness that receives Hydra's messages: the chosen agent, then the dispatch rules, then the one Hydra runs on now.
export function hydraCandidate({
  state,
  dispatch,
}: {
  state: Partial<Pick<HydraState, 'config' | 'cards'>>
  dispatch: HeadsDispatch
}): Candidate {
  const running = state.cards?.[HYDRA_CARD]?.agent?.provider
  const harness = running ? harnessOf({ provider: running }) : DEFAULT_HARNESS

  return state.config?.hydra.agent ?? dispatch.rules.hydra?.candidates[0]
    ?? dispatch.default[0] ?? { harness }
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
