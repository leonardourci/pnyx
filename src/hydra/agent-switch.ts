import type { HydraState } from '#app/model.ts'
import { readEventsFrom } from '#app/event-log.ts'
import type { AgentConfig } from '#workers/model.ts'
import type { HostedSession } from '#workers/provider.ts'
import { HYDRA_CARD } from './identity.ts'
import { ownerActor } from '#app/actors.ts'

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
  ownerBefore = Infinity,
}: {
  hydraId: string
  state: HydraState
  ownerBefore?: number
}): string {
  const after = state.hydraContext?.after ?? 0
  const messages = readEventsFrom({
    hydraId,
    offset: 0,
  })?.events.flatMap(event => {
    if (event.seq <= after) {
      return []
    }

    if (event.type === 'chat.message' && event.cardId === HYDRA_CARD && event.data.role === 'assistant') {
      return [`[Hydra] ${event.data.text}`]
    }

    if (event.type === 'hydra.message' && event.seq < ownerBefore && event.data.kind !== 'divider' && ownerActor({ actor: event.actor })) {
      return [`[owner] ${event.data.text}`]
    }

    return []
  }) ?? []

  return [
    state.hydraContext?.summary,
    ...messages,
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
      permission: async () => ({
        behavior: 'deny',
        message: 'Only the inscribe skill may save memory during this operation.',
      }),
    })) {
      if (typeof event !== 'object' || event.type !== 'turn-ended') {
        continue
      }

      if (event.outcome.status !== 'completed') {
        throw new Error(event.outcome.error ?? `Compaction ${event.outcome.status}`)
      }

      const summary = event.outcome.assistant.map(message => message.text).join('\n')
        .trim()
        || event.outcome.result?.trim()

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
