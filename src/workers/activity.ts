import type { Card } from '#tasks/model.ts'

// A worker whose session ended is stopped, so a dead job never reads as active.
export function agentActivity({ card }: { card: Card }): 'working' | 'finished' | 'stopped' | undefined {
  if (!card.agent) {
    return undefined
  }

  const activity = card.sessionActivity ?? card.activity

  return activity === 'ended' || card.outcome?.state === 'ended' ? 'stopped' : activity === 'working' ? 'working' : activity === 'finished' ? 'finished' : undefined
}
