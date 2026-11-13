import type { Card } from '#tasks/model.ts'
import type { Link } from './model.ts'
import { pendingChecks } from './model.ts'

export const IDLE_FOLLOW_MULTIPLIER = 15
export const UNRESOLVED_RETRIES = 3

export function workingTask({ card }: { card: Card }): boolean {
  return card.status?.state === 'working' || (card.sessionActivity ?? card.activity) === 'working'
}

export type ReadResult = 'found' | 'missing' | 'failed'

type Check = {
  at: number
  misses: number
  task: string
}

export function followSchedule({ interval }: { interval: number }) {
  const checks = new Map<string, Check>()
  const generations = new Map<string, number>()
  let nextGeneration = 0

  const generation = ({ task }: { task: string }) => {
    let token = generations.get(task)

    if (token === undefined) {
      token = ++nextGeneration
      generations.set(
        task,
        token,
      )
    }

    return token
  }

  const key = ({
    card,
    link,
  }: {
    card: Card
    link: Link
  }) => `${card.id}\n${link.url}`

  return {
    generation,
    // Makes the task's links due now. A restart also discards a read in flight, which may predate
    // the change the owner asked to see; an event's touch keeps it, as that read is already fresh.
    touch({
      task,
      restart = false,
    }: {
      task: string
      restart?: boolean
    }) {
      if (restart) {
        generations.set(
          task,
          ++nextGeneration,
        )
      }

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
      const merging = link.mergeAttempt && link.mergeAttempt.outcome !== 'merged'
      const active = working || merging || pendingChecks({ checks: link.checks }) > 0
      const delay = active ? interval : interval * IDLE_FOLLOW_MULTIPLIER

      return now - check.at >= delay
    },
    // A failed read (offline, expired auth, rate limit) keeps the normal schedule; only reads that
    // find no pull request count toward suspension. Returns true when this read suspends the link.
    read({
      card,
      link,
      result,
      now = Date.now(),
      started = generation({ task: card.id }),
    }: {
      card: Card
      link: Link
      result: ReadResult
      now?: number
      started?: number
    }): boolean {
      if (started !== generation({ task: card.id })) {
        return false
      }

      const id = key({
        card,
        link,
      })
      const previous = checks.get(id)?.misses ?? 0
      const misses = missesAfter({
        previous,
        result,
      })
      checks.set(
        id,
        {
          task: card.id,
          at: now,
          misses,
        },
      )

      return misses === UNRESOLVED_RETRIES && previous < UNRESOLVED_RETRIES
    },
    prune({ links }: {
      links: {
        card: Card
        link: Link
      }[]
    }) {
      const wanted = new Set(links.map(key))
      const tasks = new Set(links.map(({ card }) => card.id))

      for (const task of generations.keys()) {
        if (!tasks.has(task)) {
          generations.delete(task)
        }
      }

      for (const id of checks.keys()) {
        if (!wanted.has(id)) {
          checks.delete(id)
        }
      }
    },
  }
}

function missesAfter({
  previous,
  result,
}: {
  previous: number
  result: ReadResult
}): number {
  if (result === 'found') {
    return 0
  }

  return result === 'missing' ? previous + 1 : previous
}
