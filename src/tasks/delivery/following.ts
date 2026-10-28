import type { Card } from '#tasks/model.ts'
import type { Link } from './model.ts'

// Pnyx wakes a task's worker with news on its open pull request; a task whose worker ended, or that never had one, leaves it unwatched.
export function unwatchedPullRequests({ card }: { card: Card }): Link[] {
  if (card.sessionIds?.length && !card.stoppedAt) {
    return []
  }

  return card.links.filter(l => l.kind === 'github_pr' && l.state !== 'merged' && l.state !== 'closed')
}
