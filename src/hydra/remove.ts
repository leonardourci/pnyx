import { copyFingerprint, removalWork } from './removal-work.ts'
import { hydraPool, protectedCopiesFolder, removeHydraPool } from '#projects/remove-pool.ts'
import { requestEnv } from '#app/request-context.ts'
import { existsSync, rmSync } from 'node:fs'
import { parse, WRITE, required, meta, type Output } from '#app/cli-support.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { ownerActor } from '#app/actors.ts'
import { approvedHydraRemoval, proposeOwnerCommand } from '#app/confirmations.ts'
import { hydraRemoval } from '#app/server-state.ts'
import { HydraError } from '#store/errors.ts'
import { isManagedTask } from '#tasks/select.ts'
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

  if (state.config?.hydra.kind === 'firstmate') {
    throw new HydraError({
      message: 'Cannot remove a Firstmate Hydra',
      code: 'CONFLICT',
    })
  }

  return state
}

async function removalPlan({
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
  const recorded = new Set(copies.map(copy => copy.path))
  const paths = new Set([
    ...recorded,
    ...pool.slots.map(slot => slot.path),
  ])

  return {
    copies,
    pool,
    recorded,
    paths,
  }
}

async function removalPreview({
  id,
  state,
  plan,
}: {
  id: string
  state: ReturnType<typeof removalTarget>
  plan: Awaited<ReturnType<typeof removalPlan>>
}): Promise<string> {
  const cards = Object.values(state.cards)
  const tasks = cards.filter(card => !isManagedTask({ card }))
  const unlanded: string[] = []

  for (const card of cards) {
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

  for (const slot of plan.pool.slots) {
    if (!plan.recorded.has(slot.path)) {
      unlanded.push(`${slot.path} (unrecorded checkout; landing unknown)`)
    }
  }

  const openLinks = tasks.flatMap(card => card.links).filter(link => link.kind === 'github_pr' && link.state === 'open')
  const prs = [...new Set(openLinks.map(link => link.url))]

  const name = state.config?.name ?? id
  const unlandedPaths = unlanded.length ? unlanded.join(', ') : 'none'
  const openPullRequests = prs.length ? prs.join(', ') : 'none'

  return `Remove ${name}? Tasks: ${tasks.length}. Copies: ${plan.paths.size}. Copies with unlanded work: ${unlandedPaths}. Removal discards these copies in full, including ignored files. Open PRs: ${openPullRequests} (kept on GitHub). Projects are detached. History stays in the event log and Oracle.`
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
  const token = values.confirm
  const approved = ownerActor({ actor: actor.actor }) && typeof token === 'string'
    && approvedHydraRemoval({
      hydraId,
      id,
      token,
    })

  if (!approved) {
    const plan = await removalPlan({
      id,
      state,
    })

    return proposeOwnerCommand({
      name: 'hydra',
      args: [
        'remove',
        id,
      ],
      hydraId,
      removalSeq: state.seq,
      removalWork: await removalWork({ paths: plan.paths }),
      summary: await removalPreview({
        id,
        state,
        plan,
      }),
    })
  }

  requireRemovalIdle()

  if (!hydraRemoval.close) {
    throw new HydraError({
      message: 'Hydra removal requires the running server',
      code: 'NOT_RUNNING',
    })
  }

  removalCopies({
    id,
    state,
  })
  await hydraPool({ hydraId: id })
  requireRemovalIdle()

  if (!approvedHydraRemoval({
    hydraId,
    id,
    token,
  })) {
    throw new HydraError({
      message: 'Removal approval is no longer available',
      code: 'CONFLICT',
    })
  }

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
            removalWork: approved,
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
      message: 'Checkout work changed. Propose removal again for a fresh preview',
      code: 'CONFLICT',
    })
  }

  const verify = async ({ path }: { path: string }) => {
    const fingerprint = await copyFingerprint({ path })

    if (fingerprint !== undefined && approvedWork?.[path] !== fingerprint) {
      refuseChangedWork()
    }
  }

  removing.add(id)

  try {
    await close({ hydraId: id })
    const plan = await removalPlan({
      id,
      state,
    })
    const currentWork = await removalWork({ paths: plan.paths })

    const changed = !approvedWork || Object.entries(currentWork).some(([
      path,
      hash,
    ]) => approvedWork[path] !== hash)

    if (changed) {
      refuseChangedWork()
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
          force: true,
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
