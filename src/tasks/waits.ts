import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import { completionGaps, requireNoDependencyCycle } from './dependencies.ts'
import type { Card, TaskWait } from './model.ts'
import { findCard } from './push-rules.ts'
import { isManagedTask } from './select.ts'

export function validateWait({
  state,
  card,
  ref,
  condition,
}: {
  state: HydraState
  card: Card
  ref: string
  condition: TaskWait['condition']
}): TaskWait {
  const dependency = findCard({
    state,
    ref,
  })

  if (isManagedTask({ card: dependency }) || card.mirror || dependency.mirror) {
    throw new HydraError({
      message: 'waits must name native tasks in this Hydra',
      code: 'VALIDATION_ERROR',
    })
  }

  requireNoDependencyCycle({
    state,
    task: card.id,
    targets: [dependency.id],
  })

  return {
    task: dependency.id,
    condition,
  }
}

export function waitReadiness({
  state,
  wait,
}: {
  state: HydraState
  wait: TaskWait
}): {
  ready: boolean
  title: string
  url?: string
} {
  const dependency = state.cards[wait.task]
  const title = dependency?.title ?? wait.task

  if (!dependency) {
    return {
      ready: false,
      title,
    }
  }

  const requests = dependency.links.filter(link => link.kind === 'github_pr' && link.state !== 'closed')
  const url = requests.at(-1)?.url

  if (wait.condition === 'pr-opened') {
    return {
      ready: requests.some(link => link.state === 'open' || link.state === 'merged'),
      title,
      url,
    }
  }

  if (wait.condition === 'pr-merged') {
    return {
      ready: requests.length > 0 && requests.every(link => link.state === 'merged'),
      title,
      url,
    }
  }

  return {
    ready: completionGaps({
      state,
      card: dependency,
      visiting: new Set(),
    }).length === 0,
    title,
    url,
  }
}
