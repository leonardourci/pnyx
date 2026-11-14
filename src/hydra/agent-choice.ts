import type { HydraState } from '#app/model.ts'
import { harnessAccount } from '#workers/account-choice.ts'
import { effectiveDispatch, type HeadsDispatch, type Candidate } from '#workers/dispatch-config.ts'
import type { AgentConfig, AgentSettings } from '#workers/model.ts'
import { DEFAULT_HARNESS, harnessOf } from '#workers/providers.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { HYDRA_CARD } from './identity.ts'

// After an agent change's compaction, Hydra's next turn opens a new session from the summary, so no session holds context a change of agent would lose.
export function startsFromSummary({ state }: { state: HydraState }): boolean {
  const agent = state.cards[HYDRA_CARD]?.agent

  return agent !== undefined && state.hydraContext?.previousSession === sessionId({ agent })
}

// The agent that receives Hydra's messages: Hydra's chosen agent, its dispatch rule, the default rule, the harness Hydra runs on now, then Claude.
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

// An agent choice with the account it resolves to for its harness.
export function withAccount({ agent }: { agent: Candidate }): Candidate {
  return {
    ...agent,
    account: harnessAccount({
      effective: effectiveDispatch(),
      harness: agent.harness,
      prefer: agent.account,
    }),
  }
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
