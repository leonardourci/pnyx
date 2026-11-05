import type { Card } from '#tasks/model.ts'
import { accountLabel } from '#workers/account-choice.ts'
import type { Command } from '#web-app/connection.ts'
import { Disclosure } from '#web-shared/ui/disclosure.tsx'
import { TooltipPanel, TooltipSection } from '#web-shared/ui/tooltip.tsx'
import { useHeadsDispatch } from './heads-dispatch.ts'
import { Usage } from './usage.tsx'
import { useUsageRefresh } from './usage-ring.tsx'

export function AgentDetails({
  card,
  command,
}: {
  card: Card
  command: Command
}) {
  const { effective } = useHeadsDispatch({ command })
  const reading = useUsageRefresh({
    card,
    command,
  })
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
      agent.account ? accountLabel({
        name: agent.account,
        account: effective?.accounts[agent.account],
      }) : undefined,
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

  return (
    <TooltipPanel>
      <Usage usage={card.usage} {...reading} />
      <Disclosure title="Session details" className="usage-session-details">
        <TooltipSection>
          {settings.map(([
            key,
            value,
          ]) => <span key={key}>{settingLabel({ key })}: {value}</span>)}
        </TooltipSection>
        <TooltipSection>
          {details.filter((entry): entry is [string, string] => Boolean(entry[1]))
            .map(([
              key,
              value,
            ]) => <span key={key}>{settingLabel({ key })}: {value}</span>)}
        </TooltipSection>
      </Disclosure>
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
