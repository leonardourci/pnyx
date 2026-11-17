import { sharesWithMore } from './access-changes.ts'
import { hydraIds } from '#app/home-migration.ts'
import { hydraActor, requestEnv } from '#app/request-context.ts'
import { proposeOwnerCommand } from '#app/confirmations.ts'
import { projectsFor } from '#projects/read.ts'
import { projectIdentity } from '#projects/sources.ts'
import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { readSettings } from '#settings/store.ts'
import type { Settings } from '#settings/model.ts'
import { HydraError } from '#store/errors.ts'

import { canRead, canWrite, DEFAULT_MEMORY_ACCESS } from './space-policy.ts'

export { canRead, canWrite, DEFAULT_MEMORY_ACCESS, SPACE_NAME } from './space-policy.ts'

export function memoryAgent(): boolean {
  const env = requestEnv()
  const actor = env.PNYX_ACTOR ?? ''

  return actor === 'hydra' || actor.startsWith('worker:') || actor.startsWith('helper:') || Boolean(env.PNYX_TASK)
}

export function memoryCaller({ hydraId }: { hydraId: string }): boolean {
  return !memoryAgent() || requestEnv().PNYX_HYDRA === hydraId
}

export function memoryAccess({
  hydraId,
  state = loadHydra({ hydraId }).state,
  settings = readSettings().settings,
}: {
  hydraId: string
  state?: Pick<HydraState, 'config'>
  settings?: Settings
}) {
  const input = {
    hydraId,
    state,
    spaces: settings.memorySpaces,
  }
  const access = state.config?.memory ?? DEFAULT_MEMORY_ACCESS
  const allowed = memoryCaller({ hydraId })
  const reads = access.reads.filter(space => allowed && canRead({
    ...input,
    space,
  }))
  const writableSpace = allowed && canWrite({
    ...input,
    space: access.write,
  }) ? access.write : undefined

  return {
    reads,
    writableSpace,
    write: () => {
      if (writableSpace === undefined) {
        throw new HydraError({
          message: 'Memory is unavailable',
          code: 'NOT_FOUND',
        })
      }

      return writableSpace
    },
  }
}

export function canReadProject({
  hydraId,
  state,
  id,
}: {
  hydraId: string
  state: Pick<HydraState, 'config'>
  id: string
}): boolean {
  const settings = readSettings().settings

  return memoryCaller({ hydraId }) && canRead({
    hydraId,
    state,
    spaces: settings.memorySpaces,
    space: settings.projectSpaces[id] ?? 'shared',
  })
}

export function requireProjectMemory({
  hydraId,
  id,
}: {
  hydraId: string
  id: string
}): void {
  const state = loadHydra({ hydraId }).state

  if (!canReadProject({
    hydraId,
    state,
    id,
  })) {
    throw new HydraError({
      message: 'project not found',
      code: 'NOT_FOUND',
    })
  }
}

export async function readableProjects({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}) {
  if (!memoryCaller({ hydraId })) {
    return []
  }

  const projects = projectsFor({ state })
  const readable = await Promise.all(projects.map(async project => canReadProject({
    hydraId,
    state,
    id: (await projectIdentity(project)).id,
  })))

  return projects.filter((
    _,
    index,
  ) => readable[index])
}

export function memoryHydras() {
  return hydraIds().map(id => ({
    id,
    state: loadHydra({ hydraId: id }).state,
  }))
}

export function memoryPermission({
  hydraId,
  name,
  args,
  propose,
  widening,
  actor,
}: {
  hydraId: string
  name: string
  args: string[]
  propose: boolean
  widening: boolean
  actor: string
}) {
  if (!memoryCaller({ hydraId })) {
    throw new HydraError({
      message: 'Memory is unavailable',
      code: 'NOT_FOUND',
    })
  }

  if (propose) {
    return proposeOwnerCommand({
      hydraId,
      name,
      args: args.filter(arg => arg !== '--propose'),
    })
  }

  if (widening && hydraActor({ actor })) {
    throw new HydraError({
      message: 'Widening memory access needs the owner’s Confirm',
      code: 'OWNER_ONLY',
      help: ['Repeat with --propose'],
    })
  }

  return undefined
}

export function memoryMovePermission({
  destinationRevision,
  revision,
  hydraId,
  destination,
  args,
  propose,
  actor,
}: {
  destinationRevision: number
  revision: number
  hydraId: string
  destination: string
  args: string[]
  propose: boolean
  actor: string
}) {
  const settings = readSettings().settings
  const state = loadHydra({ hydraId }).state
  const source = memoryAccess({
    hydraId,
    state,
    settings,
  }).write()

  if (!canRead({
    hydraId,
    state,
    spaces: settings.memorySpaces,
    space: destination,
  })) {
    throw new HydraError({
      message: 'Memory is unavailable',
      code: 'NOT_FOUND',
    })
  }

  const pinned = args.some(arg => arg === '--if-revision' || arg.startsWith('--if-revision='))
  const sourceArgs = pinned ? args : [
    ...args,
    '--if-revision',
    String(revision),
  ]

  const destinationPinned = args.some(arg => arg === '--if-destination-revision' || arg.startsWith('--if-destination-revision='))
  const proposalArgs = destinationPinned ? sourceArgs : [
    ...sourceArgs,
    '--if-destination-revision',
    String(destinationRevision),
  ]

  return memoryPermission({
    hydraId,
    name: 'owner',
    args: proposalArgs,
    propose,
    actor,
    widening: sharesWithMore({
      source,
      destination,
      before: settings,
      hydras: memoryHydras(),
    }),
  })
}
