import { requestEnv } from '#app/request-context.ts'
import { existsSync, rmSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { parse, WRITE, required, meta, type Output } from '#app/cli-support.ts'
import { hydraIds, hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { ownerActor } from '#app/actors.ts'
import { proposeOwnerCommand } from '#app/confirmations.ts'
import { hydraRemoval } from '#app/server-state.ts'
import { HydraError } from '#store/errors.ts'
import { isManagedTask } from '#tasks/select.ts'
import { checkCopy, removeCopy } from '#projects/copy-check.ts'
import { hydraConfig } from './config.ts'
import { hydraEvent } from './hydra.ts'

const removing = new Set<string>()

function removalTarget({
  id,
  caller,
}: {
  id: string
  caller: string
}) {
  const ids = hydraIds()

  if (!ids.includes(id)) {
    throw new HydraError({
      message: `Unknown Hydra: ${id}`,
      code: 'NOT_FOUND',
    })
  }

  if (ids.length === 1) {
    throw new HydraError({
      message: 'Cannot remove the last Hydra',
      code: 'CONFLICT',
    })
  }

  if (id === caller) {
    throw new HydraError({
      message: 'Cannot remove the caller’s own Hydra',
      code: 'CONFLICT',
    })
  }

  const state = loadHydra({ hydraId: id }).state

  if (state.config?.hydra.kind === 'firstmate') {
    throw new HydraError({
      message: 'Cannot remove a Firstmate Hydra',
      code: 'CONFLICT',
    })
  }

  return state
}

async function removalPreview({
  id,
  caller,
}: {
  id: string
  caller: string
}): Promise<string> {
  const state = removalTarget({
    id,
    caller,
  })
  const tasks = Object.values(state.cards).filter(card => !isManagedTask({ card }))
  const copies = tasks.flatMap(card => card.copy && card.copy.state !== 'removed' ? [card.copy.path] : [])
  const unlanded: string[] = []

  for (const card of tasks) {
    if (card.copy && card.copy.state !== 'removed') {
      const check = await checkCopy({
        card,
        copy: card.copy,
      })

      if (!check.clean || !check.landed) {
        unlanded.push(card.copy.path)
      }
    }
  }

  const prs = [...new Set(tasks.flatMap(card => card.links.filter(link => link.kind === 'github_pr' && link.state === 'open').map(link => link.url)))]

  return `Remove ${state.config?.name || id}? ${tasks.length} tasks. ${copies.length} copies. Copies with unlanded work: ${unlanded.join(', ') || 'none'}. Open PRs: ${prs.join(', ') || 'none'} (kept on GitHub). Projects are detached. History stays in the event log and Oracle.`
}

export async function removeHydraCommand({ args }: { args: string[] }): Promise<Output> {
  const {
    values,
    positionals,
    hydraId: selectedHydra,
  } = parse({
    args,
    options: WRITE,
    positionals: 2,
  })
  const hydraId = requestEnv().PNYX_HYDRA || selectedHydra
  const id = required({
    value: positionals[1],
    what: 'Hydra id',
  })
  const state = removalTarget({
    id,
    caller: hydraId,
  })
  const actor = meta({ values })
  const approved = ownerActor({ actor: actor.actor }) && typeof values.confirm === 'string'
    && loadHydra({ hydraId }).state.dispatchProposals?.some(proposal => proposal.token === values.confirm && proposal.kind === 'command'
      && proposal.status === 'applying' && JSON.parse(proposal.value).name === 'hydra'
      && JSON.parse(proposal.value).args[0] === 'remove' && JSON.parse(proposal.value).args[1] === id)

  if (!approved) {
    return proposeOwnerCommand({
      name: 'hydra',
      args,
      hydraId,
      summary: await removalPreview({
        id,
        caller: hydraId,
      }),
    })
  }

  if (removing.has(id)) {
    throw new HydraError({
      message: 'This Hydra is already being removed',
      code: 'CONFLICT',
    })
  }

  if (!hydraRemoval.close) {
    throw new HydraError({
      message: 'Hydra removal requires the running server',
      code: 'NOT_RUNNING',
    })
  }

  removing.add(id)

  try {
    await hydraRemoval.close({ hydraId: id })
    const cards = Object.values(state.cards)

    for (const card of cards) {
      const copy = card.copy

      if (!copy || !existsSync(copy.path)) {
        continue
      }

      if (copy.via === 'worktree') {
        const failure = await removeCopy({
          copy,
          force: true,
        })

        if (failure) {
          throw new HydraError({
            message: `${copy.path}: ${failure}`,
            code: 'CONFLICT',
          })
        }
      } else {
        const within = relative(
          copy.path,
          copy.project,
        )

        if (!within || (!within.startsWith('..') && !isAbsolute(within))) {
          throw new HydraError({
            message: `Copy contains the project folder: ${copy.path}`,
            code: 'CONFLICT',
          })
        }

        rmSync(
          copy.path,
          {
            recursive: true,
            force: true,
          },
        )
      }
    }

    withWriter({
      hydraId: id,
      fn: ({ writer }) => {
        for (const project of writer.state.projects ?? []) {
          if (project.detached) {
            continue
          }

          const detached = hydraEvent({
            state: writer.state,
            meta: actor,
            cardId: '$projects',
            change: {
              type: 'hydra.project',
              data: {
                before: project,
                after: {
                  ...project,
                  detached: true,
                },
                sharedWith: [],
              },
            },
          })

          if ('event' in detached) {
            writer.append({ event: detached.event })
          }
        }

        const decision = hydraEvent({
          state: writer.state,
          meta: actor,
          cardId: '$board',
          change: {
            type: 'board.configured',
            data: {
              ...hydraConfig({
                state: writer.state,
                id,
              }),
              removed: true,
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })
    rmSync(
      join(
        hydraDir({ hydraId: id }),
        'copies',
      ),
      {
        recursive: true,
        force: true,
      },
    )

    return { removed: id }
  } finally {
    hydraRemoval.finished?.({ hydraId: id })
    removing.delete(id)
  }
}
