import type { TitanState } from '#app/model.ts'
import { modelOption, type ModelOption } from '#workers/provider.ts'
import { harnessAccount } from '#workers/account-choice.ts'
import { effectiveDispatch, type TitanDispatch, type Candidate } from '#workers/dispatch-config.ts'
import type { AgentConfig, AgentSettings } from '#workers/model.ts'
import { DEFAULT_HARNESS, harnessOf } from '#workers/providers.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { TITAN_CARD } from './identity.ts'
import { recordContext } from './file-context.ts'
import { compactionContext } from './history.ts'

// After an older version's agent-change compaction, Titan's next turn opens a new session from the summary, so no session holds context a change of agent would lose.
export function startsFromSummary({ state }: { state: TitanState }): boolean {
  const agent = state.cards[TITAN_CARD]?.agent

  return agent !== undefined && state.hydraContext?.previousSession === sessionId({ agent })
}

// The agent that receives Titan's messages: Titan's chosen agent, its dispatch rule, the default rule, the harness Titan runs on now, then Claude.
export function hydraCandidate({
  state,
  dispatch,
}: {
  state: Partial<Pick<TitanState, 'config' | 'cards'>>
  dispatch: TitanDispatch
}): Candidate {
  const running = state.cards?.[TITAN_CARD]?.agent?.provider
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

// A model or effort left unnamed is the harness default, and a model alias is the model it stands for, so naming what the session already runs with changes nothing.
export async function agentChanges({
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

  // A catalog that cannot load compares the names as they are.
  const offered = await models().catch(() => [])

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

// Only Othrys's recorded conversation crosses provider and account boundaries.
export function conversationContext({
  hydraId,
  state,
}: {
  hydraId: string
  state: TitanState
}): string {
  const context = compactionContext({ state })

  return [
    context.summary,
    recordContext({ hydraId }),
    'Read the recorded conversation after the saved summary before acting. Preserve message identities and order.',
  ].filter(Boolean).join('\n\n')
}
