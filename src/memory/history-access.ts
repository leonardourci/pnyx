import type { HydraEvent } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { memoryAgent, memoryCaller, polisAccess, readableProjects } from './poleis.ts'
import { OWNER_DOCUMENTS } from './budgets.ts'
import { DEFAULT_POLIS_ACCESS } from './polis-policy.ts'

export async function memoryHistoryFilter({ hydraId }: { hydraId: string }) {
  if (!memoryAgent()) {
    return () => true
  }

  const projects = await readableProjects({
    hydraId,
    state: loadHydra({ hydraId }).state,
  })
  const paths = new Set(projects.filter(project => !project.detached).map(project => project.path))
  const reads = new Set(polisAccess({ hydraId }).reads)
  const own = memoryCaller({ hydraId })

  return ({ event }: { event: HydraEvent }): boolean => {
    if (event.type === 'hydra.memory') {
      const legacyOwnerMemory = Object.hasOwn(
        OWNER_DOCUMENTS,
        event.data.key,
      )

      return own && (!legacyOwnerMemory || reads.has(DEFAULT_POLIS_ACCESS.polis))
    }

    if (event.type !== 'hydra.review') {
      return true
    }

    const access = event.data.memoryAccess

    return own && access !== undefined
      && access.poleis.every(polis => reads.has(polis))
      && access.projects.every(path => paths.has(path))
  }
}
