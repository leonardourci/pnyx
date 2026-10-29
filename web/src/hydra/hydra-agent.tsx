import { hydraDefault, useHeadsDispatch } from '#web-workers/heads-dispatch.ts'
import type { HydraState } from '#app/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { AgentPickers } from '#web-workers/agent-pickers.tsx'
import type { Command } from '#web-app/connection.ts'

const FIELDS = [
  'model',
  'effort',
  'mode',
  'fast',
] as const

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
    saveHydra,
  } = useHeadsDispatch({ command })
  const rule = effective?.dispatch.rules.hydra?.candidates[0] ?? effective?.dispatch.default[0]
  const agent: AgentConfig = state.config?.hydra.agent ?? rule ?? { harness: 'claude' }
  const inherited = rule?.harness === agent.harness ? rule : undefined
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

  // The hydra rule is what every new Hydra starts with.
  const startsWith = ({ field }: { field: 'model' | 'effort' | 'mode' }) => ({
    defaultValue: rule?.harness !== agent.harness ? undefined
      : field === 'model' ? rule.model && `${rule.harness}:${rule.model}` : rule[field],
    onDefault: ({
      value,
      harness = agent.harness,
    }: {
      value: string
      harness?: AgentConfig['harness']
    }) => void saveHydra({
      patch: hydraDefault({
        rule,
        harness,
        field,
        value,
      }),
    }).then(
      () => notify({ text: 'New Hydras will start with this.' }),
      (error: Error) => notify({ text: error.message }),
    ),
  })

  return (
    <AgentPickers
      label="Hydra agent settings"
      agent={agent}
      inherited={inherited}
      command={command}
      connected={connected}
      onChange={save}
      // Saving the named values makes Hydra run with exactly what the pickers show.
      onResolved={({ next }) => {
        if (effective && FIELDS.some(field => next[field] !== agent[field])) {
          save({ next })
        }
      }}
      startsWith={startsWith}
    />
  )
}
