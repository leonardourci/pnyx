import { ComposerSettings } from '#web-hydra/composer-ui.tsx'
import { useState } from 'react'
import type { Card } from '#tasks/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { DEFAULT_HARNESS, harnessOf } from '#workers/providers.ts'
import type { Command } from '#web-app/connection.ts'
import { Select } from '#web-shared/ui/controls.tsx'
import { AgentPickers } from './agent-pickers.tsx'
import { useHeadsDispatch } from './heads-dispatch.ts'

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
  card,
  command,
  connected,
  initial,
}: {
  card?: Card
  initial?: AgentConfig
  command: Command
  connected: boolean
}) {
  const { effective } = useHeadsDispatch({ command })
  const [
    chosen,
    choose,
  ] = useState<AgentConfig | undefined>(initial)
  const attached: AgentConfig | undefined = card?.agent && {
    harness: harnessOf({ provider: card.agent.provider }),
    account: card.agent.account,
    model: card.settings?.model,
    effort: card.settings?.effort,
  }
  const agent = chosen ?? attached ?? effective?.dispatch.default[0] ?? { harness: DEFAULT_HARNESS }
  const outside = !!card?.mirror || !!card?.agent && card.agent.host !== 'pnyx'
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

export function cardSendArgs({
  card,
  text,
  id,
  agent,
}: {
  card: string
  text: string
  id: string
  agent: AgentConfig
}): string[] {
  const args = [
    'send',
    card,
    '--text',
    text,
    '--harness',
    agent.harness,
    '--event-id',
    id,
  ]

  for (const field of [
    'account',
    'model',
    'effort',
  ] as const) {
    if (agent[field]) {
      args.push(
        `--${field}`,
        agent[field],
      )
    }
  }

  return args
}
