import { basename } from 'node:path'
import { withWriter } from '#app/writer.ts'
import { base } from '#app/command-meta.ts'
import type { HydraProject } from '#projects/model.ts'
import type { Pnyx } from './pnyx.ts'

export async function legacyDuplicate({
  pnyx,
  id,
  projects,
}: {
  pnyx: Pnyx
  id: string
  projects: Pick<HydraProject, 'path' | 'landing'>[]
}) {
  await withWriter({
    hydraId: id,
    create: true,
    fn: ({ writer }) => {
      for (const [
        index,
        project,
      ] of projects.entries()) {
        writer.append({
          event: {
            ...base({
              state: writer.state,
              cardId: '$projects',
              meta: {
                id: `${id}-project-${index}`,
                actor: 'cli',
                at: '2026-10-21T10:01:00Z',
              },
            }),
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
          },
        })
      }
    },
  })

  return pnyx.hydra({
    id,
    create: false,
  })
}
