import type { HydraEvent } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { memoryAgent, memoryCaller, polisAccess, readableProjects } from './poleis.ts'

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

  return ({ event }: { event: HydraEvent }) => event.type !== 'hydra.review' || Boolean(own && event.data.memoryAccess
    && event.data.memoryAccess.poleis.every(polis => reads.has(polis))
    && event.data.memoryAccess.projects.every(path => paths.has(path)))
}
