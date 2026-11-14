import { resolvedAccount, useHeadsDispatch } from '#web-workers/heads-dispatch.ts'
import type { HydraState } from '#app/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { AgentPickers } from '#web-workers/agent-pickers.tsx'
import type { Command } from '#web-app/connection.ts'

export function HydraAgent({
  state,
  command,
  connected,
  notify,
}: {
  state: HydraState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const {
    effective,
  } = useHeadsDispatch({ command })
  const rule = effective?.dispatch.rules.hydra?.candidates[0] ?? effective?.dispatch.default[0]
  const agent: AgentConfig = state.config?.hydra.agent ?? rule ?? { harness: 'claude' }
  const ruleAccount = rule ? resolvedAccount({
    effective,
    agent: rule,
  }) : undefined
  const sameAccount = !agent.account || agent.account === ruleAccount
  const inherited = rule?.harness === agent.harness && sameAccount ? rule : undefined
  const firstmate = state.config?.hydra.kind === 'firstmate'

  const save = ({ next }: { next: AgentConfig }) => {
    void command({
      name: 'hydra-agent',
      args: [JSON.stringify(next)],
    })
      .catch((error: Error) => notify({ text: error.message }))
  }

  if (firstmate) {
    return null
  }

  return (
    <AgentPickers
      label="Hydra agent settings"
      foldable
      agent={agent}
      lastUsed={state.hydraAgent}
      inherited={inherited}
      command={command}
      connected={connected}
      disabled={state.hydraAgentChange?.state === 'running'}
      fastNote="Applies from the next turn. It also applies to every agent this Hydra starts, heads dispatch workers and the routine helper alike, where their model has Fast."
      onChange={save}

    />
  )
}
