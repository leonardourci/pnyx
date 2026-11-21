import { openAsks } from './ask-state.ts'
import { holdBlocker, ownerGates, questionBlockers, type Blocker } from './owner-gates.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from './model.ts'
import { cardLanding } from '#tasks/delivery/model.ts'
import { knownCards } from '#tasks/select.ts'
import { touch } from './touch.ts'
import { waitReadiness } from './waits.ts'

export function requireNoDependencyCycle({
  state,
  task,
  targets,
}: {
  state: HydraState
  task: string
  targets: string[]
}): void {
  const visited = new Set<string>()

  const reaches = ({ id }: { id: string }): boolean => {
    if (id === task) {
      return true
    }

    if (visited.has(id)) {
      return false
    }

    visited.add(id)
    const card = state.cards[id]
    const edges = [...card?.prerequisites ?? []]

    if (card?.wait) {
      edges.push(card.wait.task)
    }

    return edges.some(id => reaches({ id }))
  }

  if (targets.some(id => reaches({ id }))) {
    throw new HydraError({
      message: 'a task cannot depend on itself or create a dependency cycle',
      code: 'DEPENDENCY_CYCLE',
    })
  }
}

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
    touch({
      card,
      event,
    })
  }

  return true
}

export function completionGaps({
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

  const branchLanding = cardLanding({
    card,
    projects: state.projects ?? [],
  })?.landing === 'branch'

  if (!branchLanding && pullRequests.some(link => link.state !== 'merged')) {
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
    const prerequisite = knownCards({ state })[id]

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

function readinessBlockers({
  state,
  card,
  unmet,
}: {
  state: HydraState
  card: Card
  unmet: ReturnType<typeof unmetPrerequisites>
}): Blocker[] {
  const blockers: Blocker[] = unmet.map(item => ({
    reason: `waiting for ${item.title} (${item.id}): ${item.reason}`,
    clear: `Finish ${item.id} first, or run \`pnyx task undepend ${card.id} --on ${item.id}\` if it no longer blocks this task`,
  }))

  if (card.wait) {
    const wait = waitReadiness({
      state,
      wait: card.wait,
    })

    if (!wait.ready) {
      blockers.push({
        reason: `waiting for ${wait.title} (${card.wait.task}): ${card.wait.condition}`,
        clear: `It resumes once ${card.wait.task} reaches ${card.wait.condition}; inspect the dependency with \`pnyx task show ${card.wait.task}\``,
      })
    }
  }

  if (card.hold) {
    blockers.push(holdBlocker({
      task: card.id,
      reason: card.hold.reason,
    }))
  }

  if (card.status?.state === 'paused' && card.status.hold) {
    const detail = card.status.note ? `: ${card.status.note}` : ''

    blockers.push({
      reason: `its worker declared a paused hold${detail}`,
      clear: `Once the owner gives the go, \`pnyx task start ${card.id}\` proceeds while preserving this saved worker hold`,
    })
  }

  blockers.push(...questionBlockers({ card }))

  return blockers
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
  const reasons = readinessBlockers({
    state,
    card,
    unmet,
  }).map(blocker => blocker.reason)

  return {
    ready: reasons.length === 0,
    reasons,
    unmet,
  }
}

export function startBlockers({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): Blocker[] {
  return readinessBlockers({
    state,
    card,
    unmet: unmetPrerequisites({
      state,
      card,
    }),
  })
}
