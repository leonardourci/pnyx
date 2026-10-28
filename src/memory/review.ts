import { learningDigest, staleLearnings } from './learnings.ts'
import { memoryConditions } from './conditions.ts'
import { ownerMemory } from './owner-memory.ts'
import type { HydraState } from '#app/model.ts'
import { projectsFor } from '#projects/read.ts'
import { readProjectMemory } from './project-memory.ts'
import { projectIdentity } from '#projects/sources.ts'

export function memoryReview({
  state,
  now,
}: {
  state: HydraState
  now: string
}): string[] {
  const conditions = memoryConditions()
  const layers = [
    {
      name: 'Owner',
      lines: ownerMemory().learnings?.lines ?? [],
    },
    ...projectsFor({ state }).filter(project => !project.detached)
      .map(project => ({
        name: `Project ${project.name}`,
        lines: readProjectMemory(projectIdentity(project)).learnings ?? [],
      })),
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
