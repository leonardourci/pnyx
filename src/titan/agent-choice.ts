import type { TitanState } from '#app/model.ts'
import { log } from '#app/diagnostics.ts'
import { modelOption, type ModelOption } from '#workers/provider.ts'
import { harnessAccount } from '#workers/account-choice.ts'
import { effectiveDispatch, type TitanDispatch, type Candidate } from '#workers/dispatch-config.ts'
import type { AgentConfig, AgentSettings } from '#workers/model.ts'
import { DEFAULT_HARNESS, harnessOf } from '#workers/providers.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { TITAN_CARD } from './identity.ts'

export function startsFromSummary({ state }: { state: TitanState }): boolean {
  const agent = state.cards[TITAN_CARD]?.agent

  return agent !== undefined && state.titanContext?.previousSession === sessionId({ agent })
}

// The agent that receives Titan's messages: Titan's chosen agent, its dispatch rule, the default rule, the harness Titan runs on now, then Claude.
export function titanCandidate({
  state,
  dispatch,
}: {
  state: Partial<Pick<TitanState, 'config' | 'cards'>>
  dispatch: TitanDispatch
}): Candidate {
  const running = state.cards?.[TITAN_CARD]?.agent?.provider
  const harness = running ? harnessOf({ provider: running }) : DEFAULT_HARNESS

  return state.config?.titan.agent ?? dispatch.rules.titan?.candidates[0]
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

export async function runsDifferently({
  previous,
  next,
  models,
}: {
  previous: AgentConfig
  next: AgentConfig
  models(): Promise<ModelOption[]>
}): Promise<boolean> {
  if (previous.harness !== next.harness || previous.account !== next.account) {
    return true
  }

  if (previous.model === next.model && previous.effort === next.effort) {
    return false
  }

  const offered = await models().catch((error: unknown) => {
    log({
      level: 'warn',
      operation: 'titan.model-catalog',
      error,
    })

    return []
  })

  const runs = ({ agent }: { agent: AgentConfig }) => {
    const option = modelOption({
      models: offered,
      model: agent.model,
    })

    return {
      model: option?.resolvedModel ?? option?.value ?? agent.model,
      effort: agent.effort ?? option?.defaultEffort,
    }
  }

  const was = runs({ agent: previous })
  const now = runs({ agent: next })

  return was.model !== now.model || was.effort !== now.effort
}
