import type { HydraState } from '#app/model.ts'
import type { Card } from './model.ts'
import { projectGroup } from '#projects/groups.ts'
import { HydraError } from '#store/errors.ts'
import { knownCards, rankOf, rankWithin } from './select.ts'

export function taskProjectGroup({
  state,
  card,
}: {
  state: HydraState
  card: Pick<Card, 'id' | 'parentId' | 'project'>
}) {
  let root = card
  const visited = new Set([card.id])
  const cards = knownCards({ state })

  while (root.parentId) {
    const parent = cards[root.parentId]

    if (!parent || visited.has(parent.id)) {
      break
    }

    visited.add(parent.id)
    root = parent
  }

  const label = root.project
  const project = state.projects?.find(project =>
    project.path === label || project.name === label)

  return project ? projectGroup({ project }).id : 'ideas'
}

export function taskRank({
  state,
  card,
  before,
}: {
  state: HydraState
  card: Pick<Card, 'id' | 'parentId' | 'project' | 'rank' | 'createdSeq'>
  before?: string
}): number {
  const group = taskProjectGroup({
    state,
    card,
  })
  const others = Object.values(state.cards).filter(item => item.id !== card.id
    && item.parentId === card.parentId && taskProjectGroup({
    state,
    card: item,
  }) === group)
    .sort((
      a,
      b,
    ) => rankOf({ card: a }) - rankOf({ card: b }))
  const beforeIndex = others.findIndex(item => item.id === before || item.key === before)
  const at = before ? beforeIndex : others.length

  if (at < 0) {
    throw new HydraError({
      message: 'Reorder tasks within their project and parent',
      code: 'CONFLICT',
    })
  }

  return rankWithin({
    card,
    others,
    at,
  })
}
