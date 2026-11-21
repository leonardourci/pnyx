import { git } from '#projects/git.ts'
import { inform } from '#app/command-notices.ts'
import { copyFingerprint, removalWork } from './removal-work.ts'
import { hydraPool, protectedCopiesFolder, removeHydraPool } from '#projects/remove-pool.ts'
import { requestEnv } from '#app/request-context.ts'
import { existsSync, rmSync } from 'node:fs'
import { parse, WRITE, required, meta, type Output } from '#app/cli-support.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { hydraRemoval } from '#app/server-state.ts'
import { HydraError } from '#store/errors.ts'
import { checkCopy, removeCopy } from '#projects/copy-check.ts'
import { hydraConfig } from './config.ts'
import { hydraEvent } from './hydra.ts'

const removing = new Set<string>()

function requireRemovalIdle() {
  if (removing.size > 0) {
    throw new HydraError({
      message: 'A Hydra is already being removed',
      code: 'CONFLICT',
    })
  }
}

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

  const state = loadHydra({ hydraId: id }).state
  const hasSurvivor = ids.some(otherId => otherId !== id
    && !loadHydra({ hydraId: otherId }).state.config?.removing)

  if (!state.config?.removing && !hasSurvivor) {
    inform({
      reason: 'Removing the last Hydra; create a Hydra to resume work',
      clear: 'Create a Hydra from the header in the UI',
    })
  }

  if (id === caller) {
    inform({
      reason: 'Removing the caller’s Hydra; its agent will stop',
      clear: 'Create another Hydra from the header in the UI',
    })
  }

  return state
}

async function prepareRemoval({
  id,
  state,
}: {
  id: string
  state: ReturnType<typeof removalTarget>
}) {
  const copies = removalCopies({
    id,
    state,
  })
  const pool = await hydraPool({ hydraId: id })
  const cards = Object.values(state.cards)
  const previousCopies = cards.flatMap(card => card.copy ? [card.copy.path] : [])
  const recorded = new Set(previousCopies)
  const paths = new Set([
    ...recorded,
    ...pool.slots.map(slot => slot.path),
  ])

  const records = new Map<string, typeof cards[number]>()

  for (const path of paths) {
    const candidates = cards.filter(card => card.copy?.path === path).sort((
      left,
      right,
    ) => right.updatedSeq - left.updatedSeq)
    let selected = candidates.find(card => card.copy?.state !== 'removed')

    if (!selected && existsSync(path)) {
      const branch = await git({
        cwd: path,
        args: [
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ],
      })

      if (branch.ok) {
        selected = candidates.find(card => card.copy?.branch === branch.out.trim())
      }
    }

    if (selected) {
      records.set(
        path,
        selected,
      )
    }
  }

  return {
    copies,
    pool,
    recorded: new Set(records.keys()),
    paths,
    records,
  }
}

function removalCopies({
  id,
  state,
}: {
  id: string
  state: ReturnType<typeof removalTarget>
}) {
  const cards = Object.values(state.cards)
  const copies = cards.flatMap(card => card.copy && card.copy.state !== 'removed'
    ? [card.copy] : [])

  for (const copy of copies) {
    if (!existsSync(copy.path)) {
      continue
    }

    protectedCopiesFolder({
      hydraId: id,
      root: copy.path,
      preserveSurvivors: false,
    })
  }

  return copies
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
  const hydraId = requestEnv().PNYX_HYDRA ?? selectedHydra
  const id = required({
    value: positionals[1],
    what: 'Hydra id',
  })
  const state = removalTarget({
    id,
    caller: hydraId,
  })
  const actor = meta({ values })
  const plan = await prepareRemoval({
    id,
    state,
  })
  const recordedWork = await removalWork({ paths: plan.paths })

  for (const card of plan.records.values()) {
    const copy = card.copy

    if (copy) {
      const check = await checkCopy({
        card,
        copy,
      })

      if (!check.gone && (!check.clean || !check.landed)) {
        throw new HydraError({
          message: `Copy ${copy.path} contains unlanded work`,
          code: 'CONFLICT',
          help: ['Land its work before removing this Hydra'],
        })
      }
    }
  }

  const unknown = plan.pool.slots.find(slot => !plan.recorded.has(slot.path))

  if (unknown) {
    throw new HydraError({
      message: `Copy ${unknown.path} has no recorded landing proof`,
      code: 'CONFLICT',
      help: ['This slot has no matching task record; inspect and remove it manually after landing its work'],
    })
  }

  requireRemovalIdle()

  if (!hydraRemoval.close) {
    throw new HydraError({
      message: 'Hydra removal requires the running server',
      code: 'NOT_RUNNING',
    })
  }

  // Refuses an unsafe copies folder or unreadable worktrees before the removal fence is written.
  await prepareRemoval({
    id,
    state,
  })
  requireRemovalIdle()

  withWriter({
    hydraId: id,
    removal: true,
    fn: ({ writer }) => {
      const pending = hydraEvent({
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
            removing: true,
            removalWork: recordedWork,
          },
        },
      })

      if ('event' in pending) {
        writer.append({ event: pending.event })
      }
    },
  })

  return finishHydraRemoval({ id })
}

export async function finishHydraRemoval({ id }: { id: string }): Promise<Output> {
  const state = loadHydra({ hydraId: id }).state

  if (!state.config?.removing || state.config.removed) {
    return { removed: id }
  }

  const actor = {
    actor: 'pnyx',
    at: new Date().toISOString(),
  }

  requireRemovalIdle()

  const close = hydraRemoval.close

  if (!close) {
    throw new HydraError({
      message: 'Hydra removal requires the running server',
      code: 'NOT_RUNNING',
    })
  }

  const approvedWork = state.config.removalWork

  const refuseChangedWork = () => {
    withWriter({
      hydraId: id,
      removal: true,
      fn: ({ writer }) => {
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
              removing: false,
              removalWork: undefined,
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })

    throw new HydraError({
      message: 'Checkout work changed; land its new work and run hydra remove again',
      code: 'CONFLICT',
    })
  }

  let records: Awaited<ReturnType<typeof prepareRemoval>>['records'] = new Map()

  const verify = async ({ path }: { path: string }) => {
    const fingerprint = await copyFingerprint({ path })

    if (fingerprint !== undefined && approvedWork?.[path] !== fingerprint) {
      refuseChangedWork()
    }

    if (fingerprint === undefined) {
      return
    }

    const card = records.get(path)

    if (!card?.copy) {
      refuseChangedWork()

      return
    }

    const check = await checkCopy({
      card,
      copy: card.copy,
    })
    const checked = await copyFingerprint({ path })

    if ((!check.gone && (!check.clean || !check.landed)) || checked !== fingerprint) {
      refuseChangedWork()
    }
  }

  removing.add(id)

  try {
    await close({ hydraId: id })
    const plan = await prepareRemoval({
      id,
      state,
    })

    records = plan.records

    if (!approvedWork) {
      refuseChangedWork()
    }

    // Every checkout is checked before the first deletion, so a changed one leaves the others in place.
    for (const path of plan.paths) {
      await verify({ path })
    }

    for (const copy of plan.copies) {
      protectedCopiesFolder({ hydraId: id })

      if (!existsSync(copy.path)) {
        continue
      }

      await verify({ path: copy.path })
      protectedCopiesFolder({
        hydraId: id,
        root: copy.path,
        preserveSurvivors: false,
      })

      if (copy.via === 'worktree') {
        const failure = await removeCopy({
          copy,
          force: false,
        })

        if (failure) {
          throw new HydraError({
            message: `${copy.path}: ${failure}`,
            code: 'CONFLICT',
          })
        }
      } else {
        rmSync(
          copy.path,
          {
            recursive: true,
            force: true,
          },
        )
      }
    }

    await removeHydraPool({
      hydraId: id,
      verify,
    })

    withWriter({
      hydraId: id,
      removal: true,
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
              removing: false,
              removalWork: undefined,
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })

    return { removed: id }
  } finally {
    removing.delete(id)

    hydraRemoval.finished?.({ hydraId: id })
  }
}
