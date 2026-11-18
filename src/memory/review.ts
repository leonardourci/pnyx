import { readableProjects } from '#memory/poleis.ts'
import { learningDigest, staleLearnings } from './learnings.ts'
import { memoryConditions } from './conditions.ts'
import { ownerMemory } from './owner-memory.ts'
import type { HydraState } from '#app/model.ts'
import { readableProjectMemory } from './project-memory.ts'

export async function memoryReview({
  state,
  hydraId,
  now,
}: {
  hydraId: string
  state: HydraState
  now: string
}): Promise<string[]> {
  const conditions = memoryConditions()
  const attached = (await readableProjects({
    state,
    hydraId,
  })).filter(project => !project.detached)
  const projectLayers = await Promise.all(attached.map(async project => ({
    name: `Project ${project.name}`,
    lines: (await readableProjectMemory({
      path: project.path,
      hydraId,
    }))?.learnings ?? [],
  })))
  const layers = [
    {
      name: 'Owner',
      lines: ownerMemory({ hydraId }).learnings?.lines ?? [],
    },
    ...projectLayers,
  ]

  return layers.flatMap(layer => {
    const lines = staleLearnings({
      lines: layer.lines,
      now,
      conditions,
    })

    return lines.length ? [
      `${layer.name} memory:`,
      learningDigest({
        lines,
        now,
        conditions,
      }),
    ] : []
  })
}
