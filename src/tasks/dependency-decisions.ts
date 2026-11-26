import { inform } from '#app/command-notices.ts'
import type { Decision, TitanState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from './push-rules.ts'
import { titanEvent } from '#titan/titan.ts'
import { TITAN_ACTOR, ownerActor } from '#app/actors.ts'
import { TitanError } from '#store/errors.ts'
import { isManagedTask } from './select.ts'
import { requireNoDependencyCycle } from './dependencies.ts'
import type { Card } from './model.ts'

const TASK_CARDS_ONLY = 'dependencies must name task cards in this Titan'

export function prerequisiteCards({
  state,
  prerequisites,
}: {
  state: TitanState
  prerequisites: string[]
}): Card[] {
  const targets = prerequisites.map(ref => findCard({
    state,
    ref,
  }))

  if (targets.some(task => isManagedTask({ card: task }))) {
    throw new TitanError({
      message: TASK_CARDS_ONLY,
      code: 'VALIDATION_ERROR',
    })
  }

  return targets
}

export function decideDependencies({
  state,
  ref,
  prerequisites,
  remove,
  meta,
}: {
  state: TitanState
  ref: string
  prerequisites: string[]
  remove: boolean
  meta: Meta
}): Decision {
  const targets = prerequisiteCards({
    state,
    prerequisites,
  })
  const card = findCard({
    state,
    ref,
  })

  if (isManagedTask({ card })) {
    throw new TitanError({
      message: TASK_CARDS_ONLY,
      code: 'VALIDATION_ERROR',
    })
  }

  if (!ownerActor({ actor: meta.actor }) && meta.actor !== TITAN_ACTOR) {
    inform({
      task: card.id,
      reason: 'Prerequisites changed by an agent',
      clear: `Review the prerequisites of task ${card.id} in the UI.`,
    })
  }

  const before = card.prerequisites ?? []
  const ids = targets.map(task => task.id)
  const after = remove ? before.filter(id => !ids.includes(id)) : [
    ...new Set([
      ...before,
      ...ids,
    ]),
  ]
  requireNoDependencyCycle({
    state,
    task: card.id,
    targets: after,
  })

  if (before.length === after.length && before.every((
    id,
    index,
  ) => id === after[index])) {
    return { skipped: 'unchanged' }
  }

  return titanEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.dependencies',
      data: {
        before,
        after,
      },
    },
  })
}
