import { reportReviewGaps } from '../investigation/inventory.ts'
import { openAsks } from './asks.ts'
import { ownerGates } from './gates.ts'
import { cardLanding, HydraError, type Card } from './model.ts'
import { type HydraEvent, type HydraState } from '../app/model.ts'

export function applyDependencies({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type !== 'task.dependencies') {
    return false
  }

  const card = state.cards[event.cardId]

  if (card) {
    card.prerequisites = [...event.data.after]
    card.revision++
    card.updatedSeq = event.seq
    card.updatedAt = event.at
  }

  return true
}

function completionGaps({
  state,
  card,
  visiting,
}: {
  state: HydraState
  card: Card
  visiting: Set<string>
}): string[] {
  const gaps: string[] = []

  if (card.hold) {
    gaps.push(`held for discussion: ${card.hold.reason}`)
  }

  if (ownerGates({ card }).length) {
    gaps.push('waiting for the owner')
  }

  if (openAsks({ card }).length && !ownerGates({ card }).length) {
    gaps.push('waiting for an answer')
  }

  const pullRequests = card.links.filter(link => link.kind === 'github_pr' && link.state !== 'closed')
  const merged = pullRequests.length > 0 && pullRequests.every(link => link.state === 'merged')
  const declared = card.status?.state
  const completed = declared === 'done' || (!declared && merged)

  if (!completed) {
    gaps.push(declared ?? 'not completed')
  }

  if (card.kind === 'investigation') {
    if (!card.report) {
      gaps.push('no stored investigation report')
    } else {
      gaps.push(...reportReviewGaps({
        state,
        card,
      }))
    }
  }

  const branchLanding = cardLanding({
    card,
    projects: state.projects ?? [],
  })?.landing === 'branch'

  if (card.kind !== 'investigation' && !branchLanding && pullRequests.some(link => link.state !== 'merged')) {
    gaps.push('pull request not merged')
  }

  gaps.push(...unmetPrerequisites({
    state,
    card,
    visiting,
  }).map(item => item.reason))

  return gaps
}

export function unmetPrerequisites({
  state,
  card,
  visiting = new Set<string>(),
}: {
  state: HydraState
  card: Card
  visiting?: Set<string>
}): {
  id: string
  title: string
  reason: string
}[] {
  if (visiting.has(card.id)) {
    return [
      {
        id: card.id,
        title: card.title,
        reason: 'dependency cycle',
      },
    ]
  }

  const ancestors = new Set(visiting)
  ancestors.add(card.id)

  return (card.prerequisites ?? []).flatMap(id => {
    const prerequisite = state.cards[id]

    if (!prerequisite) {
      return [
        {
          id,
          title: id,
          reason: 'prerequisite missing from this Hydra',
        },
      ]
    }

    const gaps = completionGaps({
      state,
      card: prerequisite,
      visiting: ancestors,
    })

    return gaps.length ? [
      {
        id,
        title: prerequisite.title,
        reason: gaps.join('; '),
      },
    ] : []
  })
}

export function taskReadiness({
  state,
  card,
}: {
  state: HydraState
  card: Card
}) {
  const unmet = unmetPrerequisites({
    state,
    card,
  })
  const reasons = unmet.map(item => `waiting for ${item.title} (${item.id}): ${item.reason}`)

  if (card.hold) {
    reasons.push(`held for discussion: ${card.hold.reason}`)
  }

  if (card.status?.state === 'paused' && card.status.hold) {
    reasons.push('declared paused on hold')
  }

  if (ownerGates({ card }).length || openAsks({ card }).length) {
    reasons.push('waiting for an answer')
  }

  return {
    ready: reasons.length === 0,
    reasons,
    unmet,
  }
}

export function requireReady({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): void {
  const readiness = taskReadiness({
    state,
    card,
  })

  if (!readiness.ready) {
    throw new HydraError({
      message: `task ${card.id} is not ready: ${readiness.reasons.join('; ')}`,
      code: 'TASK_NOT_READY',
      help: ['Complete or resolve the named prerequisites before starting this task'],
    })
  }
}
