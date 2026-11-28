import { openAsks } from './ask-state.ts'
import { holdBlocker, ownerGates, questionBlockers, type Blocker } from './owner-gates.ts'
import type { TitanEvent, TitanState } from '#app/model.ts'
import { TitanError } from '#store/errors.ts'
import type { Card } from './model.ts'
import { completedOutcome } from '#tasks/delivery/model.ts'
import { knownCards } from '#tasks/select.ts'
import { touch } from './touch.ts'
import { waitReadiness } from './waits.ts'

export function requireNoDependencyCycle({
  state,
  task,
  targets,
}: {
  state: TitanState
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
    throw new TitanError({
      message: 'a task cannot depend on itself or create a dependency cycle',
      code: 'DEPENDENCY_CYCLE',
    })
  }
}

export function applyDependencies({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
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
  state: TitanState
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

  if (!completedOutcome({ outcome: card.outcome })) {
    gaps.push('not completed')
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
  state: TitanState
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
          reason: 'prerequisite missing from this Titan',
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
  state: TitanState
  card: Card
  unmet: ReturnType<typeof unmetPrerequisites>
}): Blocker[] {
  const blockers: Blocker[] = unmet.map(item => ({
    reason: `waiting for ${item.title} (${item.id}): ${item.reason}`,
    clear: `Finish prerequisite ${item.id} first`,
  }))

  if (card.wait) {
    const wait = waitReadiness({
      state,
      wait: card.wait,
    })

    if (!wait.ready) {
      blockers.push({
        reason: `waiting for ${wait.title} (${card.wait.task}): ${card.wait.condition}`,
        clear: `It resumes once ${card.wait.task} reaches ${card.wait.condition}; read tasks/${card.wait.task}/task.log to inspect the dependency`,
      })
    }
  }

  if (card.hold) {
    blockers.push(holdBlocker({
      task: card.id,
      reason: card.hold.reason,
    }))
  }

  blockers.push(...questionBlockers({ card }))

  return blockers
}

export function taskReadiness({
  state,
  card,
}: {
  state: TitanState
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
  state: TitanState
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
