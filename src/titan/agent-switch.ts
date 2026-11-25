import { recordContext } from './file-context.ts'
import type { TitanState } from '#app/model.ts'
import { compactionContext } from './history.ts'
import type { AgentConfig } from '#workers/model.ts'
import { modelOption, type ModelOption } from '#workers/provider.ts'

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
