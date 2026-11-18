import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { rankOf, knownCards } from '#tasks/select.ts'
import { projectGroup } from '#projects/groups.ts'
import { taskProjectGroup } from '#tasks/order.ts'
import { projectTitle } from '#web-projects/view.ts'
import { observedStatus, type ObservedStatus } from './observed-status.ts'

export const IDEAS_COLUMN = 'ideas'
export interface ProjectColumnData {
  id: string
  title: string
  repositories: string[]
  cards: Card[]
  asks?: number
  running?: number
}

interface Rollup {
  status: ObservedStatus
  children: Card[]
  done: number
}
const rollups = new WeakMap<HydraState, {
  actions: Record<string, CurrentAction>
  children: Map<string, Card[]>
  tasks: Map<string, Rollup>
}>()

/* eslint-disable pnyx/object-params -- Array sort comparator contract. */
export function compareTasks({
  state,
  actions,
}: {
  state: HydraState
  actions: Record<string, CurrentAction>
}) {
  return (
    a: Card,
    b: Card,
  ) => statusPriority({
    status: taskRollup({
      state,
      card: a,
      actions,
    }).status,
  })
    - statusPriority({
      status: taskRollup({
        state,
        card: b,
        actions,
      }).status,
    })
    || rankOf({ card: a }) - rankOf({ card: b })
}
/* eslint-enable pnyx/object-params */

export function nextSibling({
  state,
  actions,
  card,
  cards,
}: {
  state: HydraState
  actions: Record<string, CurrentAction>
  card: Card
  cards: Card[]
}) {
  const priority = statusPriority({
    status: taskRollup({
      state,
      card,
      actions,
    }).status,
  })

  return cards.slice(cards.findIndex(item => item.id === card.id) + 1).find(item =>
    statusPriority({
      status: taskRollup({
        state,
        card: item,
        actions,
      }).status,
    }) === priority)
}

export function taskRollup({
  state,
  card,
  actions,
}: {
  state: HydraState
  card: Card
  actions: Record<string, CurrentAction>
}) {
  let cached = rollups.get(state)

  if (!cached || cached.actions !== actions) {
    const children = new Map<string, Card[]>()

    const cards = knownCards({ state })

    for (const child of Object.values(cards)) {
      if (!child.parentId) {
        continue
      }

      let ancestor = child.parentId
      const visited = new Set([child.id])

      while (cards[ancestor]?.parentId && !visited.has(ancestor)) {
        visited.add(ancestor)
        ancestor = cards[ancestor]!.parentId!
      }

      if (visited.has(ancestor)) {
        continue
      }

      const siblings = children.get(ancestor) ?? []
      siblings.push(child); children.set(
        ancestor,
        siblings,
      )
    }

    cached = {
      actions,
      children,
      tasks: new Map(),
    }
    rollups.set(
      state,
      cached,
    )
  }

  const previous = cached.tasks.get(card.id)

  if (previous) {
    return previous
  }

  const save = ({ result }: { result: Rollup }) => {
    cached.tasks.set(
      card.id,
      result,
    )

    return result
  }

  const observed = observedStatus({
    card,
    state,
    action: actions[card.id],
  })
  const own = observed.kind === 'not-started'
    ? {
      ...observed,
      kind: 'queued',
      text: 'queued',
    } : observed
  const children = cached.children.get(card.id) ?? []

  if (!children.length) {
    return save({
      result: {
        status: own,
        children,
        done: 0,
      },
    })
  }

  const parts = children.map(child => observedStatus({
    card: child,
    state,
    action: actions[child.id],
  }))
  const done = parts.filter(part => part.kind === 'done').length
  let status: ObservedStatus
  const needsYou = [
    own,
    ...parts,
  ].find(part => part.kind === 'asks')
  const running = [
    own,
    ...parts,
  ].find(part => part.kind === 'working')

  if (needsYou) {
    status = {
      ...needsYou,
      text: 'waiting for you',
    }
  } else if (running) {
    status = {
      ...running,
      text: 'running',
    }
  } else if (done === children.length) {
    status = own
  } else {
    status = {
      kind: 'waiting',
      text: 'waiting',
      details: 'Sub-tasks remain',
    }
  }

  return save({
    result: {
      status,
      children,
      done,
    },
  })
}

export function statusPriority({ status }: { status: ObservedStatus }) {
  if (status.kind === 'asks') {
    return 0
  }

  if (status.kind === 'working') {
    return 1
  }

  if (status.kind === 'done') {
    return 3
  }

  return 2
}

export function projectColumns({
  state,
  cards,
  actions,
  order,
}: {
  state: HydraState
  cards: Card[]
  actions: Record<string, CurrentAction>
  order: string[]
}) {
  const columns = new Map<string, ProjectColumnData>([
    [
      IDEAS_COLUMN,
      {
        id: IDEAS_COLUMN,
        title: 'Ideas',
        repositories: [],
        cards: [],
      },
    ],
  ])

  for (const project of state.projects ?? []) {
    const hasTasks = cards.some(card =>
      card.project === project.path || card.project === project.name)

    if (project.detached && !hasTasks) {
      continue
    }

    const group = projectGroup({ project })
    const column = columns.get(group.id) ?? {
      id: group.id,
      title: group.name,
      repositories: [],
      cards: [],
    }
    column.repositories.push(project.path)
    columns.set(
      group.id,
      column,
    )
  }

  for (const card of cards) {
    if (card.parentId && cards.some(parent => parent.id === card.parentId)) {
      continue
    }

    const id = taskProjectGroup({
      state,
      card,
    })
    const column = columns.get(id) ?? {
      id,
      title: projectTitle({ project: id }),
      repositories: [id],
      cards: [],
    }
    column.cards.push(card)
    columns.set(
      id,
      column,
    )
  }

  for (const column of columns.values()) {
    const priorities = column.cards.map(card => statusPriority({
      status: taskRollup({
        state,
        card,
        actions,
      }).status,
    }))
    column.asks = priorities.filter(priority => priority === 0).length
    column.running = priorities.filter(priority => priority === 1).length
    column.cards.sort(compareTasks({
      state,
      actions,
    }))
  }

  return [...columns.values()].sort((
    a,
    b,
  ) => {
    if (a.id === IDEAS_COLUMN) {
      return -1
    }

    if (b.id === IDEAS_COLUMN) {
      return 1
    }

    const first = order.indexOf(a.id), second = order.indexOf(b.id)

    return (first < 0 ? order.length : first) - (second < 0 ? order.length : second)
  })
}
