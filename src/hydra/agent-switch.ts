import type { HydraState } from '#app/model.ts'
import { historyCommand, lastCompactionSummary } from './history.ts'
import type { AgentConfig } from '#workers/model.ts'
import type { HostedSession } from '#workers/provider.ts'

export function agentChangeKind({
  previous,
  next,
}: {
  previous: AgentConfig
  next: AgentConfig
}): 'agent' | 'effort' | undefined {
  if (previous.harness !== next.harness || previous.account !== next.account
    || previous.model !== next.model) {
    return 'agent'
  }

  return previous.effort !== next.effort ? 'effort' : undefined
}

// Only Pnyx's recorded conversation crosses provider and account boundaries.
export function conversationContext({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}): string {
  return [
    lastCompactionSummary({ state }),
    `Read the recorded conversation since the last compaction with ${historyCommand({
      hydraId,
      since: 'last-compaction',
    })}. Follow every continuation cursor before acting on the conversation.`,
  ].filter(Boolean).join('\n\n')
}

export async function agentChangeTurn({
  session,
  text,
  id,
}: {
  session: HostedSession
  text: string
  id: string
}): Promise<string> {
  async function* input() {
    yield {
      id,
      text,
      images: [],
    }
  }

  try {
    for await (const event of session.run({
      input: input(),
      permission: async ({
        tool,
        input,
      }) => {
        let command = input.command

        if (Array.isArray(command) && command.length === 3 && (command[1] === '-lc' || command[1] === '-c')) {
          command = command[2]
        }

        const shell = tool === 'Bash' || tool === 'Command'
        const read = typeof command === 'string' && /^pnyx-axi hydra history(?: --(?:hydra|since|through|budget|after) [a-zA-Z0-9:_.-]+)*$/.test(command)

        return shell && read ? { behavior: 'allow' } : {
          behavior: 'deny',
          message: 'Compaction may only read history with the supplied pnyx-axi hydra history command.',
        }
      },
    })) {
      if (typeof event !== 'object' || event.type !== 'turn-ended') {
        continue
      }

      if (event.outcome.status !== 'completed') {
        throw new Error(event.outcome.error ?? `Compaction ${event.outcome.status}`)
      }

      const assistantSummary = event.outcome.assistant.map(message => message.text).join('\n')
        .trim()
      const resultSummary = event.outcome.result?.trim()
      const summary = assistantSummary.length ? assistantSummary : resultSummary

      if (!summary) {
        throw new Error('Compaction ended without a summary')
      }

      return summary
    }

    throw new Error('Compaction ended without a completed turn')
  } finally {
    await session.close()
  }
}
