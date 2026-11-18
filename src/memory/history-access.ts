import type { HydraEvent } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { memoryAgent, memoryCaller, polisAccess, readableProjects } from './poleis.ts'
import { OWNER_DOCUMENTS } from './budgets.ts'
import { DEFAULT_POLIS_ACCESS } from './polis-policy.ts'
import { readMemoryContext } from './context.ts'

export async function memoryHistoryFilter({ hydraId }: { hydraId: string }) {
  if (!memoryAgent()) {
    return () => true
  }

  if (!memoryCaller({ hydraId })) {
    return ({ event }: { event: HydraEvent }) =>
      event.type !== 'hydra.memory' && event.type !== 'hydra.review'
  }

  const { paths, reads } = await readMemoryContext({
    read: async () => {
      const projects = await readableProjects({
        hydraId,
        state: loadHydra({ hydraId }).state,
      })

      return {
        paths: new Set(projects.filter(project => !project.detached).map(project => project.path)),
        reads: new Set(polisAccess({ hydraId }).reads),
      }
    },
  })

  return ({ event }: { event: HydraEvent }): boolean => {
    if (event.type === 'hydra.memory') {
      const legacyOwnerMemory = Object.hasOwn(
        OWNER_DOCUMENTS,
        event.data.key,
      )

      return !legacyOwnerMemory || reads.has(DEFAULT_POLIS_ACCESS.polis)
    }

    if (event.type !== 'hydra.review') {
      return true
    }

    const access = event.data.memoryAccess

    return access !== undefined
      && access.poleis.every(polis => reads.has(polis))
      && access.projects.every(path => paths.has(path))
  }
}
