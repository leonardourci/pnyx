import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { HydraProject } from '#projects/model.ts'
import type { Pnyx } from './pnyx.ts'

// A repository has one Hydra; a second Hydra can only hold it as a duplicate imported from before that rule.
export async function legacyDuplicate({
  pnyx,
  id,
  projects,
}: {
  pnyx: Pnyx
  id: string
  projects: Pick<HydraProject, 'path' | 'landing'>[]
}) {
  const folder = join(
    process.env.PNYX_HOME!,
    'hydras',
    id,
  )
  mkdirSync(
    folder,
    { recursive: true },
  )
  writeFileSync(
    join(
      folder,
      'events.jsonl',
    ),
    projects.map((
      project,
      index,
    ) => `${JSON.stringify({
      v: 1,
      seq: index + 1,
      id: `${id}-project-${index}`,
      at: '2026-10-21T10:01:00Z',
      actor: 'cli',
      cardId: '$projects',
      type: 'hydra.project',
      data: {
        before: null,
        after: {
          ...project,
          name: basename(project.path),
          detached: false,
        },
        sharedWith: [],
      },
    })}\n`).join(''),
  )

  return await pnyx.hydra({
    id,
    create: false,
  })
}
