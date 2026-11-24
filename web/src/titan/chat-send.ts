import type { Command } from '#web-app/connection.ts'
import type { AgentConfig } from '#workers/model.ts'
import { DEFAULT_HARNESS } from '#workers/providers.ts'
import { TITAN_CARD } from '#titan/identity.ts'

export function sendChatMessage({
  command,
  card,
  text,
  id,
  agent = { harness: DEFAULT_HARNESS },
  outside = false,
  onChecking,
}: {
  command: Command
  card: string
  text: string
  id: string
  agent?: AgentConfig
  outside?: boolean
  onChecking?(): void
}) {
  if (card === TITAN_CARD) {
    return command({
      name: 'hydra',
      args: [
        'send',
        `--text=${text}`,
        '--event-id',
        id,
      ],
      onChecking,
    })
  }

  return command({
    name: outside ? 'reply' : 'task',
    args: outside ? [
      card,
      text,
      id,
    ] : cardSendArgs({
      card,
      text,
      id,
      agent,
    }),
    onChecking,
  })
}

function cardSendArgs({
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
    `--text=${text}`,
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
