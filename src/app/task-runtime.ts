import { trackChildren } from '#workers/children.ts'
import { moveAgentMemory } from '#workers/agent-memory.ts'
import { isManagedTask } from '#tasks/select.ts'
import type { TitanState } from './model.ts'
import { othrysHome } from '#store/storage.ts'
import { canonical, taskRuntimeDir } from '#store/paths.ts'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TitanError } from '#store/errors.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { Card } from '#tasks/model.ts'
import type { PermissionDecision, HostedUsage } from '#workers/provider.ts'
import type { LiveSessionScope } from '#workers/live-sessions.ts'
import type { Live } from './host-types.ts'
import type { CompactionHandoff } from '#workers/compaction/control.ts'

export interface ToolApplication {
  revision: string
  attempted: boolean
  attempts: number
  retryAt: number
}

interface TaskHandoff {
  compaction: CompactionHandoff
  tools?: ToolApplication
}

export interface TaskSessionOwner extends LiveSessionScope {
  resumeTools({
    task,
    text,
  }: {
    task: string
    text: string
  }): void
  requireMovable({ task }: { task: string }): void
  suspendTask({ card }: { card: Card }): TaskHandoff
  adoptTask({
    card,
    handoff,
  }: {
    card: Card
    handoff: TaskHandoff
  }): void
  retire({
    key,
    entry,
    permanent,
    failed,
  }: {
    key: string
    entry: Live
    permanent?: boolean
    failed?: boolean
  }): void
}

interface PermissionWaiter {
  card: string
  entry: Live
  finish({ result }: { result: PermissionDecision }): void
}

interface HomeRuntime {
  hosts: Map<string, TaskSessionOwner>
  tasks: Map<string, {
    key: string
    entry: Live
  }>
  processes: Map<string, {
    titanId: string
    controller: AbortController
    children: ReturnType<typeof trackChildren>
  }>
  permissions: Map<string, PermissionWaiter>
  usages: Map<string, Map<string, Omit<HostedUsage, 'type'>>>
}

const homes = new Map<string, HomeRuntime>()

function runtimeHome(): string {
  const path = resolve(othrysHome())

  return canonical({ path }) ?? path
}

function runtime({ home = runtimeHome() }: { home?: string } = {}): HomeRuntime {
  let current = homes.get(home)

  if (!current) {
    current = {
      hosts: new Map(),
      tasks: new Map(),
      processes: new Map(),
      permissions: new Map(),
      usages: new Map(),
    }
    homes.set(
      home,
      current,
    )
  }

  return current
}

export function registerTaskHost({ owner }: { owner: TaskSessionOwner }): () => void {
  const home = runtimeHome()
  const current = runtime({ home })

  if (current.hosts.has(owner.titanId)) {
    throw new TitanError({
      code: 'CONFLICT',
      message: `A task host already serves Titan ${owner.titanId}`,
    })
  }

  current.hosts.set(
    owner.titanId,
    owner,
  )

  return () => {
    if (current.hosts.get(owner.titanId) === owner) {
      current.hosts.delete(owner.titanId)
      current.usages.delete(owner.titanId)
    }

    if (!current.hosts.size && homes.get(home) === current) {
      homes.delete(home)
    }
  }
}

export function trackTaskSession({
  key,
  entry,
  owner,
}: {
  key: string
  entry: Live
  owner: TaskSessionOwner
}): void {
  entry.owner = owner

  if (entry.task === TITAN_CARD) {
    return
  }

  const current = runtime()
  const previous = current.tasks.get(entry.task)

  if (previous && previous.entry !== entry) {
    throw new TitanError({
      code: 'SESSION_CONFLICT',
      message: `Task ${entry.task} already has a native runtime`,
    })
  }

  current.tasks.set(
    entry.task,
    {
      key,
      entry,
    },
  )
}

export function untrackTaskSession({ entry }: { entry: Live }): void {
  const current = runtime()

  if (current.tasks.get(entry.task)?.entry === entry) {
    current.tasks.delete(entry.task)
  }
}

export const permissionWaiters = (): Map<string, PermissionWaiter> => runtime().permissions

export function taskUsages({ titanId }: { titanId: string }): Map<string, Omit<HostedUsage, 'type'>> {
  const { usages } = runtime()
  const readings = usages.get(titanId)

  if (readings) {
    return readings
  }

  const empty = new Map<string, Omit<HostedUsage, 'type'>>()
  usages.set(
    titanId,
    empty,
  )

  return empty
}

export function taskTitan({ task }: { task: string }): string | undefined {
  const current = runtime()

  return current.tasks.get(task)?.entry.owner?.titanId ?? current.processes.get(task)?.titanId
}

function taskProcess({
  titanId,
  task,
}: {
  titanId: string
  task: string
}) {
  const current = runtime()
  let owned = current.processes.get(task)

  if (!owned) {
    owned = {
      titanId,
      controller: new AbortController(),
      children: trackChildren({
        titanId,
        task,
      }),
    }
    current.processes.set(
      task,
      owned,
    )
  }

  return owned
}

export function taskController({
  titanId,
  task,
}: {
  titanId: string
  task: string
}): AbortController {
  const owned = taskProcess({
    titanId,
    task,
  })

  if (owned.controller.signal.aborted) {
    owned.controller = new AbortController()
  }

  owned.titanId = titanId

  return owned.controller
}

export const taskChildren = ({
  titanId,
  task,
}: {
  titanId: string
  task: string
}) => taskProcess({
  titanId,
  task,
}).children

export function abortTitanTasks({ titanId }: { titanId: string }): void {
  for (const owned of runtime().processes.values()) {
    if (owned.titanId === titanId) {
      owned.controller.abort()
    }
  }
}

export function taskToolCleanup({ titanId }: { titanId: string }): () => Promise<void> {
  const { processes } = runtime()

  return async () => {
    for (const owned of processes.values()) {
      if (owned.titanId === titanId) {
        await owned.children.stopAll()
      }
    }
  }
}

export function trackedTaskTools({ titanId }: { titanId: string }): Set<string> {
  return new Set([...runtime().processes].flatMap(([
    task,
    owned,
  ]) =>
    owned.titanId === titanId && owned.children.tasks().has(task) ? [task] : []))
}

export async function sweepTaskProcesses({
  titanId,
  state,
}: {
  titanId: string
  state: TitanState
}): Promise<boolean> {
  let ready = true

  for (const card of Object.values(state.cards)) {
    const recorded = existsSync(join(
      taskRuntimeDir({ task: card.id }),
      'children.json',
    ))

    if (!isManagedTask({ card }) && (card.agent?.host === 'othrys' || recorded)) {
      const owned = taskProcess({
        titanId,
        task: card.id,
      })
      owned.titanId = titanId
      ready = await owned.children.sweep() && ready
    }
  }

  return ready
}

export function prepareTaskRuntimeMove({
  task,
  from,
  to,
}: {
  task: string
  from: string
  to: string
}): (({ card }: { card: Card }) => void) | undefined {
  const current = runtime()
  const active = current.tasks.get(task)
  const process = current.processes.get(task)

  current.hosts.get(from)?.requireMovable({ task })

  if (!active && !process) {
    return undefined
  }

  const source = active?.entry.owner ?? current.hosts.get(from)
  const target = current.hosts.get(to)

  if (!source || source.titanId !== from || !target || source.closing() || target.closing()) {
    throw new TitanError({
      code: 'CONFLICT',
      message: `Task ${task} needs both Titan runtimes ready before moving`,
    })
  }

  if (active && target.live.has(active.key)) {
    throw new TitanError({
      code: 'SESSION_CONFLICT',
      message: `The destination Titan already runs session ${active.key}`,
    })
  }

  return ({ card }) => {
    const sourceUsage = current.usages.get(from)
    const targetUsage = current.usages.get(to)

    for (const session of card.sessionIds ?? []) {
      const reading = sourceUsage?.get(session)

      if (reading && targetUsage) {
        targetUsage.set(
          session,
          reading,
        )
        sourceUsage?.delete(session)
      }
    }

    if (active && current.tasks.get(task) === active) {
      source.live.delete(active.key)
      target.live.set(
        active.key,
        active.entry,
      )
      active.entry.owner = target
      active.entry.generation = card.steeringGeneration

      if (active.entry.assignment) {
        active.entry.assignment.steeringGeneration = card.steeringGeneration
      }
    }

    const controlled = current.processes.get(task)

    if (controlled) {
      controlled.titanId = to
    }

    target.adoptTask({
      card,
      handoff: source.suspendTask({ card }),
    })
    moveAgentMemory({
      task,
      from,
      to,
    })
  }
}
