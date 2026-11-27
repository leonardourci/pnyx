import type { AgentSession } from './model.ts'
import type { Card } from '#tasks/model.ts'
import { sessionId } from './session-attachments.ts'

// The sessions that have a working subagent, by session id. A pass over every card builds it once and passes it to each call.
export function workingChildSessions({
  sessions,
}: {
  sessions: Record<string, AgentSession>
}): Set<string> {
  const working = Object.values(sessions).filter(child =>
    child.agent.agentId && (child.sessionActivity ?? child.activity) === 'working')

  return new Set(working.map(child => sessionId({
    agent: {
      provider: child.agent.provider,
      sessionId: child.agent.sessionId,
    },
  })))
}

// A worker whose session ended is stopped, so a dead job never reads as active.
export function agentActivity({
  card,
  cards,
  sessions,
  workingChildren = sessions && workingChildSessions({ sessions }),
}: {
  card: Card
  cards?: Record<string, Card>
  sessions?: Record<string, AgentSession>
  workingChildren?: Set<string>
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
  const parent = sessionId({
    agent: {
      provider: agent.provider,
      sessionId: agent.sessionId,
    },
  })
  const observedChildWorking = workingChildren
    ? workingChildren.has(parent)
    : card.facts?.childWorking ?? childSeen()
  const childWorking = !agent.agentId && observedChildWorking

  if (activity === 'working' || childWorking) {
    return 'working'
  }

  return activity === 'finished' ? 'finished' : undefined
}
