import { learningDigest, staleLearnings } from './learnings.ts'
import { memoryConditions } from './conditions.ts'
import { ownerMemory } from './owner-memory.ts'
import type { HydraState } from '#app/model.ts'
import { projectsFor } from '#projects/read.ts'
import { readProjectMemory } from './project-memory.ts'
import { projectIdentity } from '#projects/sources.ts'

export async function memoryReview({
  state,
  now,
}: {
  state: HydraState
  now: string
}): Promise<string[]> {
  const conditions = memoryConditions()
  const attached = projectsFor({ state }).filter(project => !project.detached)
  const projectLayers = await Promise.all(attached.map(async project => ({
    name: `Project ${project.name}`,
    lines: readProjectMemory(await projectIdentity(project)).learnings ?? [],
  })))
  const layers = [
    {
      name: 'Owner',
      lines: ownerMemory().learnings?.lines ?? [],
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
