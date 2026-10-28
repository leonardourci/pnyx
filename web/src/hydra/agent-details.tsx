import type { Card } from '../../../src/tasks/model.ts'
import { TooltipPanel, TooltipSection } from '../shared/ui/tooltip.tsx'
import { harnessName } from './view.ts'

export function AgentDetails({ card }: { card: Card }) {
  const agent = card.agent

  if (!agent) {
    return null
  }

  const settings = Object.entries(card.settings ?? {})
    .filter(([key]) => key !== 'model')
  const details: [string, string | undefined][] = [
    [
      'Agent type',
      agent.agentType,
    ],
    [
      'Account',
      agent.account,
    ],
    [
      'Host',
      agent.host === 'pnyx' ? 'Pnyx' : undefined,
    ],
    [
      'Folder',
      agent.cwd ?? card.folder,
    ],
    [
      'Session',
      agent.sessionId,
    ],
    [
      'Agent id',
      agent.agentId,
    ],
    [
      'Paseo agent',
      agent.paseoAgentId,
    ],
    [
      'Paseo address',
      agent.paseoUrl,
    ],
    ...Object.entries(card.terminal ?? {}),
  ]
  const spend = card.spend
  const tokens = spend?.total !== undefined
    ? `${spend.total.toLocaleString()} recorded task tokens` : 'Task tokens not recorded'

  return (
    <TooltipPanel>
      <strong>{harnessName({ provider: agent.provider })}</strong>
      <TooltipSection>
        <span>Model: {card.settings?.model ?? 'not recorded'}</span>
        {settings.map(([
          key,
          value,
        ]) => <span key={key}>{settingLabel({ key })}: {value}</span>)}
      </TooltipSection>
      <TooltipSection>
        <strong>{tokens}</strong>
        {spend?.total !== undefined && (
          <span>
            {(spend.worker ?? 0).toLocaleString()} worker ·
            {' '}{(spend.hydra ?? 0).toLocaleString()} attributed Hydra
          </span>
        )}
        <span>Task totals include earlier workers. Unattributed Hydra turns are excluded.</span>
        <span>Usage is never estimated.</span>
        {spend && spend.unavailable > 0 && (
          <span>{spend.unavailable} transcript(s) unavailable.</span>
        )}
        {spend?.sharedHydra && <span>Includes Hydra turns shared with other tasks.</span>}
      </TooltipSection>
      <TooltipSection>
        {details.filter((entry): entry is [string, string] => Boolean(entry[1]))
          .map(([
            key,
            value,
          ]) => <span key={key}>{settingLabel({ key })}: {value}</span>)}
      </TooltipSection>
    </TooltipPanel>
  )
}

function settingLabel({ key }: { key: string }): string {
  const words = key.replace(
    /([a-z])([A-Z])/g,
    '$1 $2',
  )

  return words.charAt(0).toUpperCase() + words.slice(1)
}
