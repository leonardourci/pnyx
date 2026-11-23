import type { HydraState } from '#app/model.ts'
import { canonical } from '#store/paths.ts'
import { readNativeHydra } from '#app/native-read.ts'
import { projectsFor } from '#projects/read.ts'
import { hydraConfig } from '#hydra/config.ts'
import { recordContext } from '#hydra/file-context.ts'
import { liveTask, rankOf } from '#tasks/select.ts'

const CONTEXT_TASKS = 5
const hydraId = process.argv[2] ?? 'default'
const folder = canonical({ path: process.cwd() })
const { state }: { state: HydraState } = readNativeHydra({ hydraId })
const project = projectsFor({ state }).find(project => !project.detached
  && folder && (folder === project.path || folder.startsWith(`${project.path}/`)))

if (project) {
  const done = new Set(hydraConfig({ state }).columns.filter(column => column.role === 'done').map(column => column.id))
  const open = Object.values(state.cards).filter(card => liveTask({ card })
    && card.project === project.path && !done.has(card.column))
    .sort((
      a,
      b,
    ) => rankOf({ card: a }) - rankOf({ card: b }))

  console.log([
    `Pnyx Hydra ${hydraId}, project ${project.name}: ${open.length} open tasks.`,
    ...open.slice(
      0,
      CONTEXT_TASKS,
    ).map(card => `${card.id}: ${card.title} (${card.column})`),
    recordContext({ hydraId }),
  ].join('\n'))
}
