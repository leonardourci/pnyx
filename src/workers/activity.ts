import type { AgentSession } from './model.ts'
import type { Card } from '#tasks/model.ts'
import { rootSessionId } from './session-attachments.ts'

export function findSessionsWithWorkingChild({
  sessions,
}: {
  sessions: Record<string, AgentSession>
}): Set<string> {
  const workingChildren = Object.values(sessions).filter(child =>
    child.agent.agentId && (child.sessionActivity ?? child.activity) === 'working')

  return new Set(workingChildren.map(child => rootSessionId({ agent: child.agent })))
}

// A worker whose session ended is stopped, so a dead job never reads as active.
export function agentActivity({
  card,
  cards,
  sessions,
  sessionsWithWorkingChild,
}: {
  card: Card
  cards?: Record<string, Card>
  sessions?: Record<string, AgentSession>
  sessionsWithWorkingChild?: ReadonlySet<string>
}): 'working' | 'finished' | 'stopped' | undefined {
  const agent = card.agent

  if (!agent) {
    return undefined
  }

  const session = sessions?.[card.sessionIds?.[0] ?? '']
  const observed = session?.sessionActivity ?? session?.activity
  const activity = observed ?? card.sessionActivity ?? card.activity

  if (activity === 'ended' || activity === 'interrupted') {
    return 'stopped'
  }

  // The page has only shown cards, so it reads the server's answer instead.
  const childSeen = () => Object.values(cards ?? {}).some(child =>
    child.agent?.agentId && child.agent.provider === agent.provider
    && child.agent.sessionId === agent.sessionId
    && agentActivity({ card: child }) === 'working')
  const parent = rootSessionId({ agent })
  const observedChildWorking = sessions
    ? (sessionsWithWorkingChild ?? findSessionsWithWorkingChild({ sessions })).has(parent)
    : card.facts?.childWorking ?? childSeen()
  const childWorking = !agent.agentId && observedChildWorking

  if (activity === 'working' || childWorking) {
    return 'working'
  }

  return activity === 'finished' ? 'finished' : undefined
}
