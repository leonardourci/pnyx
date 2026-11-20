import type { AgentSession } from './model.ts'
import type { Card } from '#tasks/model.ts'

// A worker whose session ended is stopped, so a dead job never reads as active.
export function agentActivity({
  card,
  cards,
  sessions,
}: {
  card: Card
  cards?: Record<string, Card>
  sessions?: Record<string, AgentSession>
}): 'working' | 'finished' | 'stopped' | undefined {
  const agent = card.agent

  if (!agent) {
    return undefined
  }

  const session = sessions?.[card.sessionIds?.[0] ?? '']
  const observed = session?.sessionActivity ?? session?.activity
  const activity = observed ?? card.sessionActivity ?? card.activity

  if (activity === 'ended' || activity === 'interrupted' || card.outcome?.state === 'ended') {
    return 'stopped'
  }

  // The page has only shown cards, so it reads the server's answer instead.
  const childSeen = () => Object.values(cards ?? {}).some(child =>
    child.agent?.agentId && child.agent.provider === agent.provider
    && child.agent.sessionId === agent.sessionId
    && agentActivity({ card: child }) === 'working')
  const activeChild = Object.values(sessions ?? {}).some(child => child.agent.agentId
    && child.agent.provider === agent.provider && child.agent.sessionId === agent.sessionId
    && (child.sessionActivity ?? child.activity) === 'working')
  const childWorking = !agent.agentId && (sessions ? activeChild : card.facts?.childWorking ?? childSeen())

  if (activity === 'working' || childWorking) {
    return 'working'
  }

  return activity === 'finished' ? 'finished' : undefined
}
