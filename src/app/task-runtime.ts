import { trackChildren } from '#workers/children.ts'
import { moveAgentMemory } from '#workers/agent-memory.ts'
import { isManagedTask } from '#tasks/select.ts'
import type { HydraState } from './model.ts'
import { pnyxHome } from '#store/storage.ts'
import { canonical, taskRuntimeDir } from '#store/paths.ts'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HydraError } from '#store/errors.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
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
  changed(): void
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
    hydraId: string
    controller: AbortController
    children: ReturnType<typeof trackChildren>
  }>
  permissions: Map<string, PermissionWaiter>
  usages: Map<string, Omit<HostedUsage, 'type'>>
}

const homes = new Map<string, HomeRuntime>()

function runtimeHome(): string {
  const path = resolve(pnyxHome())

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

  if (current.hosts.has(owner.hydraId)) {
    throw new HydraError({
      code: 'CONFLICT',
      message: `A task host already serves Hydra ${owner.hydraId}`,
    })
  }

  current.hosts.set(
    owner.hydraId,
    owner,
  )

  return () => {
    if (current.hosts.get(owner.hydraId) === owner) {
      current.hosts.delete(owner.hydraId)
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

  if (entry.task === HYDRA_CARD) {
    return
  }

  const current = runtime()
  const previous = current.tasks.get(entry.task)

  if (previous && previous.entry !== entry) {
    throw new HydraError({
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

export const taskUsages = (): Map<string, Omit<HostedUsage, 'type'>> => runtime().usages

export function taskHydra({ task }: { task: string }): string | undefined {
  const current = runtime()

  return current.tasks.get(task)?.entry.owner?.hydraId ?? current.processes.get(task)?.hydraId
}

function taskProcess({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}) {
  const current = runtime()
  let owned = current.processes.get(task)

  if (!owned) {
    owned = {
      hydraId,
      controller: new AbortController(),
      children: trackChildren({
        hydraId,
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
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}): AbortController {
  const owned = taskProcess({
    hydraId,
    task,
  })

  if (owned.controller.signal.aborted) {
    owned.controller = new AbortController()
  }

  owned.hydraId = hydraId

  return owned.controller
}

export const taskChildren = ({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}) => taskProcess({
  hydraId,
  task,
}).children

export function abortHydraTasks({ hydraId }: { hydraId: string }): void {
  for (const owned of runtime().processes.values()) {
    if (owned.hydraId === hydraId) {
      owned.controller.abort()
    }
  }
}

export function taskToolCleanup({ hydraId }: { hydraId: string }): () => Promise<void> {
  const { processes } = runtime()

  return async () => {
    for (const owned of processes.values()) {
      if (owned.hydraId === hydraId) {
        await owned.children.stopAll()
      }
    }
  }
}

export function trackedTaskTools({ hydraId }: { hydraId: string }): Set<string> {
  return new Set([...runtime().processes].flatMap(([
    task,
    owned,
  ]) =>
    owned.hydraId === hydraId && owned.children.tasks().has(task) ? [task] : []))
}

export async function sweepTaskProcesses({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}): Promise<boolean> {
  let ready = true

  for (const card of Object.values(state.cards)) {
    const recorded = existsSync(join(
      taskRuntimeDir({ task: card.id }),
      'children.json',
    ))

    if (!isManagedTask({ card }) && (card.agent?.host === 'pnyx' || recorded)) {
      const owned = taskProcess({
        hydraId,
        task: card.id,
      })
      owned.hydraId = hydraId
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

  if (!source || source.hydraId !== from || !target || source.closing() || target.closing()) {
    throw new HydraError({
      code: 'CONFLICT',
      message: `Task ${task} needs both Hydra runtimes ready before moving`,
    })
  }

  if (active && target.live.has(active.key)) {
    throw new HydraError({
      code: 'SESSION_CONFLICT',
      message: `The destination Hydra already runs session ${active.key}`,
    })
  }

  return ({ card }) => {
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
      controlled.hydraId = to
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

    source.changed()
    target.changed()
  }
}
