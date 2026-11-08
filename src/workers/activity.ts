import type { Card } from '#tasks/model.ts'

// A worker whose session ended is stopped, so a dead job never reads as active.
export function agentActivity({
  card,
  cards,
}: {
  card: Card
  cards?: Record<string, Card>
}): 'working' | 'finished' | 'stopped' | undefined {
  const agent = card.agent

  if (!agent) {
    return undefined
  }

  const activity = card.sessionActivity ?? card.activity

  if (activity === 'ended' || card.outcome?.state === 'ended') {
    return 'stopped'
  }

  const childWorking = !agent.agentId && Object.values(cards ?? {}).some(child =>
    child.agent?.agentId && child.agent.provider === agent.provider
    && child.agent.sessionId === agent.sessionId
    && agentActivity({ card: child }) === 'working')

  if (activity === 'working' || childWorking) {
    return 'working'
  }

  return activity === 'finished' ? 'finished' : undefined
}
