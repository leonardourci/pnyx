import { resolvedAccount, useTitanDispatch } from '#web-workers/heads-dispatch.ts'
import type { TitanState } from '#app/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { AgentPickers } from '#web-workers/agent-pickers.tsx'
import type { Command } from '#web-app/connection.ts'

export function TitanAgent({
  state,
  command,
  connected,
  notify,
}: {
  state: TitanState
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const {
    effective,
  } = useTitanDispatch({ command })
  const rule = effective?.dispatch.rules.titan?.candidates[0] ?? effective?.dispatch.default[0]
  const agent: AgentConfig = state.config?.titan.agent ?? rule ?? { harness: 'claude' }
  const ruleAccount = rule ? resolvedAccount({
    effective,
    agent: rule,
  }) : undefined
  const sameAccount = !agent.account || agent.account === ruleAccount
  const inherited = rule?.harness === agent.harness && sameAccount ? rule : undefined

  const save = ({ next }: { next: AgentConfig }) => {
    void command({
      name: 'titan-agent',
      args: [JSON.stringify(next)],
    })
      .catch((error: Error) => notify({ text: error.message }))
  }

  return (
    <AgentPickers
      label="Titan agent settings"
      foldable
      agent={agent}
      lastUsed={state.titanAgent}
      inherited={inherited}
      command={command}
      connected={connected}
      fastNote="Applies from the next turn. It also applies to every agent this Titan starts, heads dispatch workers and the routine helper alike, where their model has Fast."
      onChange={save}

    />
  )
}
