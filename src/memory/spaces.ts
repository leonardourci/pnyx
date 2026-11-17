import { projectsFor } from '#projects/read.ts'
import { projectIdentity } from '#projects/sources.ts'
import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { readSettings } from '#settings/store.ts'
import type { Settings } from '#settings/model.ts'
import { HydraError } from '#store/errors.ts'

import { canRead, canWrite, DEFAULT_MEMORY_ACCESS } from './space-policy.ts'

export { canRead, canWrite, DEFAULT_MEMORY_ACCESS, SPACE_NAME } from './space-policy.ts'
export type { MemoryAccess, MemorySpaces } from './space-policy.ts'

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

  return {
    reads: Object.keys(settings.memorySpaces).filter(space => canRead({
      ...input,
      space,
    })),
    write: () => {
      if (!canWrite({
        ...input,
        space: access.write,
      })) {
        throw new HydraError({
          message: 'Memory is unavailable',
          code: 'NOT_FOUND',
        })
      }

      return access.write
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

  return canRead({
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
