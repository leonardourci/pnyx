import type { TitanState } from '#app/model.ts'
import { completionGaps } from './dependencies.ts'
import type { TaskWait } from './model.ts'

export function waitReadiness({
  state,
  wait,
}: {
  state: TitanState
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
