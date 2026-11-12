import type { Card } from '#tasks/model.ts'
import type { Link } from './model.ts'
import { pendingChecks } from './model.ts'

export const IDLE_FOLLOW_MULTIPLIER = 15
export const UNRESOLVED_RETRIES = 3

export function workingTask({ card }: { card: Card }): boolean {
  return card.status?.state === 'working' || (card.sessionActivity ?? card.activity) === 'working'
}

type Check = {
  at: number
  misses: number
  task: string
}

export function followSchedule({ interval }: { interval: number }) {
  const checks = new Map<string, Check>()
  const key = ({
    card,
    link,
  }: {
    card: Card
    link: Link
  }) => `${card.id}\n${link.url}`

  return {
    touch({ task }: { task: string }) {
      for (const [
        id,
        check,
      ] of checks) {
        if (check.task === task) {
          checks.delete(id)
        }
      }
    },
    due({
      card,
      link,
      now = Date.now(),
    }: {
      card: Card
      link: Link
      now?: number
    }) {
      const check = checks.get(key({
        card,
        link,
      }))

      if (!check) {
        return true
      }

      if (check.misses >= UNRESOLVED_RETRIES) {
        return false
      }

      const working = workingTask({ card })
      const active = working || pendingChecks({ checks: link.checks }) > 0
      const delay = active ? interval : interval * IDLE_FOLLOW_MULTIPLIER

      return now - check.at >= delay
    },
    read({
      card,
      link,
      found,
      now = Date.now(),
    }: {
      card: Card
      link: Link
      found: boolean
      now?: number
    }) {
      const id = key({
        card,
        link,
      })
      const previous = checks.get(id)
      checks.set(
        id,
        {
          task: card.id,
          at: now,
          misses: found ? 0 : (previous?.misses ?? 0) + 1,
        },
      )
    },
    prune({ links }: {
      links: {
        card: Card
        link: Link
      }[]
    }) {
      const wanted = new Set(links.map(key))

      for (const id of checks.keys()) {
        if (!wanted.has(id)) {
          checks.delete(id)
        }
      }
    },
  }
}
