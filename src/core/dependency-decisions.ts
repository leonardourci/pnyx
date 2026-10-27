import type { Decision, HydraState } from '../app/model.ts'
import type { Meta } from '../app/command-meta.ts'
import { findCard } from './decide.ts'
import { hydraEvent, HYDRA_CARD } from './hydra.ts'
import { HYDRA_ACTOR, ownerActor } from '../app/actors.ts'
import { HydraError } from './model.ts'

export function decideDependencies({
  state,
  ref,
  prerequisites,
  remove,
  meta,
}: {
  state: HydraState
  ref: string
  prerequisites: string[]
  remove: boolean
  meta: Meta
}): Decision {
  if (!ownerActor({ actor: meta.actor }) && meta.actor !== HYDRA_ACTOR) {
    throw new HydraError({
      message: 'only Hydra or the owner manages prerequisites',
      code: 'OWNER_ONLY',
    })
  }

  const card = findCard({
    state,
    ref,
  })
  const targets = prerequisites.map(ref => findCard({
    state,
    ref,
  }))

  if ([
    card,
    ...targets,
  ].some(task => task.id === HYDRA_CARD || task.automaticTask)) {
    throw new HydraError({
      message: 'dependencies must name task cards in this Hydra',
      code: 'VALIDATION_ERROR',
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
  const visited = new Set<string>()

  const reachesTask = ({ id }: { id: string }): boolean => {
    if (id === card.id) {
      return true
    }

    if (visited.has(id)) {
      return false
    }

    visited.add(id)

    return (state.cards[id]?.prerequisites ?? []).some(id => reachesTask({ id }))
  }

  if (after.some(id => reachesTask({ id }))) {
    throw new HydraError({
      message: 'a task cannot depend on itself or create a dependency cycle',
      code: 'DEPENDENCY_CYCLE',
    })
  }

  if (before.length === after.length && before.every((
    id,
    index,
  ) => id === after[index])) {
    return { skipped: 'unchanged' }
  }

  return hydraEvent({
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
