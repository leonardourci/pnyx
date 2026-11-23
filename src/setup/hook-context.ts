import type { HydraState } from '#app/model.ts'
import { canonical } from '#store/paths.ts'
import { readNativeHydra } from '#app/native-read.ts'
import { projectsFor } from '#projects/read.ts'
import { cardStatus, hasCompletedOutcome } from '#tasks/card-status.ts'
import { recordContext } from '#hydra/file-context.ts'
import { liveTask, rankOf } from '#tasks/select.ts'

const CONTEXT_TASKS = 5
const hydraId = process.argv[2] ?? 'default'
const folder = canonical({ path: process.cwd() })
const { state }: { state: HydraState } = readNativeHydra({ hydraId })
const project = projectsFor({ state }).find(project => !project.detached
  && folder && (folder === project.path || folder.startsWith(`${project.path}/`)))

if (project) {
  const open = Object.values(state.cards)
    .filter(card => liveTask({ card }) && card.project === project.path && !hasCompletedOutcome({ card }))
    .map(card => ({
      card,
      status: cardStatus({
        card,
        cards: state.cards,
        sessions: state.sessions,
      }),
    }))
    .filter(({ status }) => status.kind !== 'done' && status.kind !== 'merged')
    .sort((
      a,
      b,
    ) => rankOf({ card: a.card }) - rankOf({ card: b.card }))

  console.log([
    `Pnyx Hydra ${hydraId}, project ${project.name}: ${open.length} open tasks.`,
    ...open.slice(
      0,
      CONTEXT_TASKS,
    ).map(({
      card,
      status,
    }) => `${card.id}: ${card.title} (${status.text})`),
    recordContext({ hydraId }),
  ].join('\n'))
}
