import { ComposerSettings } from '#web-titan/composer-ui.tsx'
import { useSessionView, sessionViewKey } from '#web-app/session-view.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { DEFAULT_HARNESS, harnessOf } from '#workers/providers.ts'
import type { Command } from '#web-app/connection.ts'
import { Select } from '#web-shared/ui/controls.tsx'
import { AgentPickers } from './agent-pickers.tsx'
import { useTitanDispatch } from './heads-dispatch.ts'

export interface RepositoryOption {
  value: string
  label: string
}

export function RepositoryPicker({
  value,
  repositories,
  change,
  disabled = false,
}: {
  value: string
  repositories: RepositoryOption[]
  change({ value }: { value: string }): void
  disabled?: boolean
}) {
  return (
    <Select
      label="Repository"
      value={value}
      options={repositories}
      onChange={change}
      disabled={disabled || !repositories.length}
    />
  )
}

export function useCardAgent({
  identity,
  card,
  command,
  connected,
  initial,
}: {
  identity: string
  card?: Card
  initial?: AgentConfig
  command: Command
  connected: boolean
}) {
  const { effective } = useTitanDispatch({ command })
  const [
    chosen,
    choose,
  ] = useSessionView<AgentConfig | undefined>({
    key: sessionViewKey({
      scope: 'worker',
      id: identity,
      field: 'agentSelection',
    }),
    initial,
  })
  const attached: AgentConfig | undefined = card?.agent && {
    harness: harnessOf({ provider: card.agent.provider }),
    account: card.agent.account,
    model: card.settings?.model,
    effort: card.settings?.effort,
  }
  const agent = chosen ?? attached ?? effective?.dispatch.default[0] ?? { harness: DEFAULT_HARNESS }
  const outside = !!card?.agent && card.agent.host !== 'pnyx'
  const settings = (
    <ComposerSettings>
      <AgentPickers
        agent={agent}
        command={command}
        connected={connected}
        disabled={outside}
        label="Worker agent"
        selectionLabel="Worker model"
        defaultAction="none"
        fields={['effort']}
        foldable
        onChange={({ next }) => choose(next)}
      />
    </ComposerSettings>
  )

  return {
    agent,
    settings,
    outside,
  }
}
