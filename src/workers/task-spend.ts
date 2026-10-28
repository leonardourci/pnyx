import { isAbsolute } from 'node:path'
import { readUsage, usageReader, type RecordedUsage, type UsageReader } from '#integrations/hooks/usage.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { AgentRef } from './model.ts'
import { readTranscript } from '#oracle/index.ts'

export interface TaskSpend {
  worker?: number
  hydra?: number
  total?: number
  unavailable: number
  sharedHydra: boolean
}

// Only what attribution reads from the Hydra, small enough to hand to the spend worker.
export interface SpendInputs {
  tasks: string[]
  hydraSession?: string
  sessions: {
    id: string
    taskId?: string | null
    agent: Pick<AgentRef, 'provider' | 'transcriptPath'>
  }[]
  configurations: {
    at: string
    session?: string
  }[]
  assignments: {
    at: string
    session: string
    before: string | null
    after: string | null
  }[]
}

// ponytail: transcripts are append-only, so a file keeps its reader until it shrinks or is replaced.
const readers = new Map<string, {
  identity: string
  pos: number
  reader: UsageReader
}>()

function transcriptUsage({ agent }: { agent: SpendInputs['sessions'][number]['agent'] }): RecordedUsage[] | undefined {
  const path = agent.transcriptPath

  if (!path || !isAbsolute(path) || !path.endsWith('.jsonl')) {
    return undefined
  }

  const known = readers.get(path)
  const same = known?.reader.provider === agent.provider

  try {
    const tail = readTranscript({
      cursor: {
        source: path,
        identity: same ? known.identity : '',
        pos: same ? known.pos : 0,
      },
    })

    if (!tail) {
      return undefined
    }

    const reader = same && !tail.reset ? known.reader : usageReader({ provider: agent.provider })

    for (const line of tail.lines) {
      readUsage({
        reader,
        value: line.record,
      })
    }

    readers.set(
      path,
      {
        identity: tail.identity,
        pos: tail.end,
        reader,
      },
    )

    return reader.rows
  } catch {
    return undefined
  }
}

const declaredTasks = ({ state }: { state: HydraState }) => Object.values(state.cards)
  .filter(card => card.tracking === 'declared' && !card.automaticTask)
  .map(card => card.id)

export function spendInputs({
  state,
  events,
  tasks = declaredTasks({ state }),
}: {
  state: HydraState
  events: HydraEvent[]
  tasks?: string[]
}): SpendInputs {
  const configurations: SpendInputs['configurations'] = []
  const assignments: SpendInputs['assignments'] = []

  for (const event of events) {
    if (event.type === 'board.configured') {
      configurations.push({
        at: event.at,
        session: event.data.hydra.session,
      })
    } else if (event.type === 'task.session') {
      assignments.push({
        at: event.at,
        session: event.data.session,
        before: event.data.before,
        after: event.data.after,
      })
    }
  }

  return {
    tasks,
    hydraSession: state.config?.hydra.session,
    sessions: Object.values(state.sessions ?? {}).map(session => ({
      id: session.id,
      taskId: session.taskId,
      agent: {
        provider: session.agent.provider,
        transcriptPath: session.agent.transcriptPath,
      },
    })),
    configurations,
    assignments,
  }
}

// One pass over the sessions for every task at once: each transcript is attributed row by row,
// a row to the task its session was assigned to at that moment, or to the tasks a Hydra report names.
export function spendFor({ inputs }: { inputs: SpendInputs }): Record<string, TaskSpend> {
  const result: Record<string, TaskSpend> = Object.fromEntries(inputs.tasks.map(task => [
    task,
    {
      unavailable: 0,
      sharedHydra: false,
    },
  ]))
  const configurations = inputs.configurations.map(configuration => ({
    time: Date.parse(configuration.at),
    session: configuration.session,
  }))
  const hydraSessions = new Set<string | undefined>([
    ...configurations.map(configuration => configuration.session),
    inputs.hydraSession,
  ])
  const bySession = new Map<string, {
    time: number
    before: string | null
    after: string | null
  }[]>()

  for (const assignment of inputs.assignments) {
    const list = bySession.get(assignment.session) ?? []
    list.push({
      time: Date.parse(assignment.at),
      before: assignment.before,
      after: assignment.after,
    })
    bySession.set(
      assignment.session,
      list,
    )
  }

  const seen = new Map<string, Set<string>>()

  for (const session of inputs.sessions) {
    const assignments = bySession.get(session.id) ?? []
    const tasks = new Set(assignments.flatMap(assignment => [
      assignment.before,
      assignment.after,
    ]).filter((id): id is string => id !== null))

    if (session.taskId) {
      tasks.add(session.taskId)
    }

    const wasHydra = hydraSessions.has(session.id)
    const identity = session.agent.transcriptPath ?? session.id
    // A transcript shared by several sessions counts once per task.
    const candidates = wasHydra ? inputs.tasks : inputs.tasks.filter(task => tasks.has(task))
    const counted = new Set(candidates.filter(task => {
      const known = seen.get(task) ?? new Set()

      if (known.has(identity)) {
        return false
      }

      seen.set(
        task,
        known.add(identity),
      )

      return true
    }))

    if (!counted.size) {
      continue
    }

    const rows = transcriptUsage({ agent: session.agent })

    if (!rows?.length) {
      for (const task of counted) {
        result[task]!.unavailable++
      }

      continue
    }

    for (const row of rows) {
      const time = row.at ? Date.parse(row.at) : undefined

      if (wasHydra) {
        let hydraSession = configurations.length ? undefined : inputs.hydraSession

        if (time !== undefined) {
          for (const configuration of configurations) {
            if (configuration.time <= time) {
              hydraSession = configuration.session
            }
          }
        }

        if (session.id === hydraSession) {
          for (const task of row.tasks) {
            if (counted.has(task)) {
              result[task]!.hydra = (result[task]!.hydra ?? 0) + row.tokens
              result[task]!.sharedHydra ||= row.tasks.length > 1
            }
          }

          continue
        }
      }

      let assigned: string | null | undefined = assignments[0]?.before

      if (time !== undefined) {
        for (const assignment of assignments) {
          if (assignment.time > time) {
            break
          }

          assigned = assignment.after
        }
      }

      if (assigned === undefined && !assignments.length && tasks.size === 1) {
        assigned = session.taskId
      }

      if (assigned && counted.has(assigned)) {
        result[assigned]!.worker = (result[assigned]!.worker ?? 0) + row.tokens
      }
    }
  }

  for (const spend of Object.values(result)) {
    if (spend.worker !== undefined || spend.hydra !== undefined) {
      spend.total = (spend.worker ?? 0) + (spend.hydra ?? 0)
    }
  }

  return result
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
  return spendFor({
    inputs: spendInputs({
      state,
      events,
      tasks: [task],
    }),
  })[task]!
}
