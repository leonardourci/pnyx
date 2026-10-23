import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { recordedUsage, type RecordedUsage } from '../integrations/hooks/usage.ts'
import type { AgentRef, HydraEvent, HydraState } from '../core/model.ts'

export interface TaskSpend {
  worker?: number
  hydra?: number
  total?: number
  unavailable: number
  sharedHydra: boolean
}

const cache = new Map<string, {
  stamp: string
  rows: RecordedUsage[]
}>()

function transcriptUsage({ agent }: { agent: AgentRef }): RecordedUsage[] | undefined {
  const path = agent.transcriptPath

  if (!path || !isAbsolute(path) || !path.endsWith('.jsonl')) {
    return undefined
  }

  try {
    const stat = statSync(path)
    const stamp = `${agent.provider}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    const known = cache.get(path)

    if (known?.stamp === stamp) {
      return known.rows
    }

    const records: unknown[] = []

    for (const line of readFileSync(
      path,
      'utf8',
    ).split('\n')) {
      if (!line.trim()) {
        continue
      }

      try {
        records.push(JSON.parse(line))
      } catch { /* A writer may not have finished the last record. */ }
    }

    const rows = recordedUsage({
      provider: agent.provider,
      records,
    })
    cache.set(
      path,
      {
        stamp,
        rows,
      },
    )

    return rows
  } catch {
    return undefined
  }
}

export function taskSpend({
  state,
  events,
  task,
}: {
  state: HydraState
  events: HydraEvent[]
  task: string
}): TaskSpend {
  const result: TaskSpend = {
    unavailable: 0,
    sharedHydra: false,
  }
  const configurations = events.filter(event => event.type === 'board.configured')
  const hydraSessions = new Set(configurations.map(event => event.data.hydra.session))
  hydraSessions.add(state.config?.hydra.session)
  const seen = new Set<string>()

  for (const session of Object.values(state.sessions ?? {})) {
    const assignments = events.filter((event): event is Extract<HydraEvent, { type: 'task.session' }> => event.type === 'task.session' && event.data.session === session.id)
    const tasks = new Set(assignments.flatMap(event => [
      event.data.before,
      event.data.after,
    ]).filter((id): id is string => id !== null))

    if (session.taskId) {
      tasks.add(session.taskId)
    }

    const wasHydra = hydraSessions.has(session.id)

    if (!wasHydra && !tasks.has(task)) {
      continue
    }

    const identity = session.agent.transcriptPath ?? session.id

    if (seen.has(identity)) {
      continue
    }

    seen.add(identity)
    const rows = transcriptUsage({ agent: session.agent })

    if (!rows?.length) {
      result.unavailable++
      continue
    }

    for (const row of rows) {
      let hydraSession = configurations.length ? undefined : state.config?.hydra.session

      if (row.at) {
        const time = Date.parse(row.at)

        for (const event of configurations) {
          if (Date.parse(event.at) <= time) {
            hydraSession = event.data.hydra.session
          }
        }
      }

      const isHydra = wasHydra && session.id === hydraSession

      if (isHydra) {
        if (row.tasks.includes(task)) {
          result.hydra = (result.hydra ?? 0) + row.tokens
          result.sharedHydra = result.sharedHydra || row.tasks.length > 1
        }

        continue
      }

      let assigned: string | null | undefined = assignments[0]?.data.before

      if (row.at) {
        const time = Date.parse(row.at)

        for (const event of assignments) {
          if (Date.parse(event.at) > time) {
            break
          }

          assigned = event.data.after
        }
      }

      if (assigned === undefined && !assignments.length && tasks.size === 1) {
        assigned = session.taskId
      }

      if (assigned === task) {
        result.worker = (result.worker ?? 0) + row.tokens
      }
    }
  }

  if (result.worker !== undefined || result.hydra !== undefined) {
    result.total = (result.worker ?? 0) + (result.hydra ?? 0)
  }

  return result
}

export function hydraSpend({
  state,
  events,
}: {
  state: HydraState
  events: HydraEvent[]
}): Record<string, TaskSpend> {
  return Object.fromEntries(Object.values(state.cards).filter(card => card.tracking === 'declared' && !card.automaticTask)
    .map(card => [
      card.id,
      taskSpend({
        state,
        events,
        task: card.id,
      }),
    ]))
}
