import type { HydraState } from '#app/model.ts'
import type { Card } from './model.ts'
import { projectGroup } from '#projects/groups.ts'
import { HydraError } from '#store/errors.ts'
import { rankOf, rankWithin } from './select.ts'

export function taskProjectGroup({
  state,
  card,
}: {
  state: HydraState
  card: Card
}) {
  const parent = card.parentId && state.cards[card.parentId]
  const label = parent ? parent.project : card.project
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
  card: Card
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
