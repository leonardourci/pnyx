import { inform } from '#app/command-notices.ts'
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

export function checkProjectsRevision({
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
  }) => cards.flatMap(card => {
    const refusal = moveRefusal({
      hydraId: id,
      to,
      source: state,
      target,
      card,
      moving: cards.map(card => card.id),
    })
    const openPR = card.links.find(link => link.kind === 'github_pr' && link.state === 'open')

    if (openPR) {
      inform({
        task: card.id,
        reason: `Moving a task with open pull request ${openPR.url}`,
        clear: `Use pnyx-axi task refresh-links ${card.id} --hydra ${to} to refresh it`,
      })
    }

    const reason = refusal?.message

    return reason ? [`${card.id} (${card.title}): ${reason}`] : []
  }))

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
    inform({
      reason: 'Repository keeper selected by an agent',
      clear: 'pnyx-axi project keep <path> --hydra <keeper>',
    })
  }

  const keeper = loadHydra({ hydraId }).state
  checkProjectsRevision({
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

      checkProjectsRevision({
        state: target.state,
        meta,
      })

      const current = migrationPlan({
        to: hydraId,
        project,
        ids,
        stateFor: ({ id }) => writers.get(id)!.state,
      })
      const moving = {
        tasks: current.flatMap(({ cards }) => cards.map(card => card.id)),
        sessions: current.flatMap(({ cards }) => cards.flatMap(card => card.sessionIds ?? [])),
      }
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
            moving,
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
