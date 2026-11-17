import { randomUUID } from 'node:crypto'
import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { ownerActor } from '#app/actors.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HydraError } from '#store/errors.ts'
import { moveRefusal, releaseWorker, stageTaskMove } from '#tasks/move.ts'
import { isManagedTask } from '#tasks/select.ts'
import { matchesProject } from './identity.ts'
import { findProject, sharingHydras } from './read.ts'
import type { HydraProject } from './model.ts'

function checkKeeperRevision({
  state,
  meta,
}: {
  state: HydraState
  meta: Meta
}) {
  const revision = state.projectsRevision ?? 0

  if (meta.ifRevision !== undefined && meta.ifRevision !== revision) {
    throw new HydraError({
      message: `revision ${revision}, not ${meta.ifRevision}`,
      code: 'REVISION_CONFLICT',
    })
  }
}

function migrationPlan({
  to,
  project,
  ids,
  stateFor,
}: {
  to: string
  project: HydraProject
  ids: string[]
  stateFor({ id }: { id: string }): HydraState
}) {
  const target = stateFor({ id: to })
  const sources = ids.map(id => {
    const state = stateFor({ id })
    const attached = findProject({
      state,
      ref: project.path,
      attached: true,
    })
    const candidates = Object.values(state.cards).filter(card => !isManagedTask({ card }))
    const cards = candidates.filter(card => matchesProject({
      project: attached,
      ref: card.project,
    }))

    return {
      id,
      state,
      project: attached,
      cards,
    }
  })
  const refused = sources.flatMap(({
    id,
    state,
    cards,
  }) => {
    if (state.config?.hydra.kind === 'firstmate') {
      const reason = 'Firstmate owns its project attachment and task moves'

      return cards.length ? cards.map(card => `${card.id} (${card.title}): ${reason}`)
        : [`Hydra ${id}: ${reason}`]
    }

    return cards.flatMap(card => {
      const refusal = moveRefusal({
        hydraId: id,
        to,
        source: state,
        target,
        card,
      })
      const openPR = card.links.find(link => link.kind === 'github_pr' && link.state === 'open')
      const reason = refusal?.message ?? (openPR ? `open pull request ${openPR.url}` : undefined)

      return reason ? [`${card.id} (${card.title}): ${reason}`] : []
    })
  })

  if (refused.length) {
    throw new HydraError({
      message: `Repository keeper unchanged. Blocking tasks: ${refused.join('; ')}`,
      code: 'CONFLICT',
      help: ['Settle every blocker, then retry the same keeper choice. Nothing moved.'],
    })
  }

  return sources
}

export async function keepProject({
  hydraId,
  ref,
  meta,
}: {
  hydraId: string
  ref: string
  meta: Meta
}) {
  if (!ownerActor({ actor: meta.actor })) {
    throw new HydraError({
      message: 'Only the owner can choose a repository keeper',
      code: 'OWNER_ONLY',
    })
  }

  const keeper = loadHydra({ hydraId }).state
  checkKeeperRevision({
    state: keeper,
    meta,
  })

  const sourceMeta = {
    ...meta,
    ifRevision: undefined,
  }
  const project = findProject({
    state: keeper,
    ref,
    attached: true,
  })
  const ids = sharingHydras({
    hydraId,
    path: project.path,
  }).map(hydra => hydra.id)
  const sources = migrationPlan({
    to: hydraId,
    project,
    ids,
    stateFor: ({ id }) => loadHydra({ hydraId: id }).state,
  })

  for (const {
    id,
    cards,
  } of sources) {
    for (const card of cards) {
      await releaseWorker({
        hydraId: id,
        card,
        actor: meta.actor,
        rerun: `pnyx-axi project keep ${JSON.stringify(project.path)} --hydra ${hydraId}`,
      })
    }
  }

  return withWriter({
    hydraId,
    also: ids,
    fn: ({
      writer: target,
      writers,
    }) => {
      findProject({
        state: target.state,
        ref: project.path,
        attached: true,
      })

      checkKeeperRevision({
        state: target.state,
        meta,
      })

      const current = migrationPlan({
        to: hydraId,
        project,
        ids,
        stateFor: ({ id }) => writers.get(id)!.state,
      })
      const moved: string[] = []
      const attempt = meta.id ?? randomUUID()

      for (const {
        id,
        project: attached,
        cards,
      } of current) {
        const source = writers.get(id)!

        for (const card of cards) {
          stageTaskMove({
            hydraId: id,
            source,
            target,
            cardId: card.id,
            to: hydraId,
            move: `${attempt}:${id}:${card.id}`,
            meta: sourceMeta,
          })
          moved.push(card.id)
        }

        const detached = hydraEvent({
          state: source.state,
          meta: sourceMeta,
          cardId: '$projects',
          change: {
            type: 'hydra.project',
            data: {
              before: attached,
              after: {
                ...attached,
                detached: true,
              },
              sharedWith: [],
            },
          },
        })

        if ('event' in detached) {
          source.append({ event: detached.event })
        }
      }

      return {
        keeper: hydraId,
        project: project.path,
        moved,
      }
    },
  })
}
