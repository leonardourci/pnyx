import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { matchesProject, sameProjectPath } from './identity.ts'
import { commonDir, git, onBranch } from './git.ts'
import { checkCopy, removeCopy } from './copy-check.ts'
import type { HydraProject, TaskCopy } from './model.ts'
import { projectsFor } from './read.ts'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { pnyxHome } from '#store/storage.ts'
import { canonical } from '#store/paths.ts'
import { HydraError } from '#store/errors.ts'
import { isFolder } from '#workers/folders.ts'

const claims = new Map<string, {
  hydraId: string
  task?: string
}>()
const POOL_IDLE = 2

export const liveCopy = ({ card }: { card: Card }) => (card.copy?.state === 'removed' ? undefined : card.copy)

// An unnamed Hydra names its task branches after its id.
export const branchHydraName = ({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}) => state.config?.name || hydraId

export function recordedBranches({
  hydraId,
  state,
  project,
}: {
  hydraId: string
  state: HydraState
  project: string
}): string[] {
  const branches = new Set<string>()

  for (const id of hydraIds()) {
    const current = id === hydraId ? state : loadHydra({ hydraId: id }).state

    for (const { copy } of Object.values(current.cards)) {
      if (copy?.branch && sameProjectPath({
        left: copy.project,
        right: project,
      })) {
        branches.add(copy.branch)
      }
    }
  }

  return [...branches]
}

export function copiesDir(): string {
  const home = resolve(pnyxHome())

  return join(
    canonical({ path: home }) ?? home,
    'copies',
  )
}

export function requireUnlinkedCopyFolder({ path }: { path: string }): void {
  if (lstatSync(
    path,
    { throwIfNoEntry: false },
  )?.isSymbolicLink()) {
    throw new HydraError({
      message: `Copies folder is a symbolic link: ${path}`,
      code: 'CONFLICT',
    })
  }
}

export function slots({
  project,
}: {
  project: HydraProject
}): string[] {
  const dir = copiesDir()
  const prefix = `${project.name}-`

  requireUnlinkedCopyFolder({ path: dir })

  if (!isFolder({ path: dir })) {
    return []
  }

  return readdirSync(
    dir,
    { withFileTypes: true },
  )
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix) && /^\d+$/.test(entry.name.slice(prefix.length)))
    .map(entry => join(
      dir,
      entry.name,
    ))
}

const runsIn = ({
  state,
  path,
}: {
  state: HydraState
  path: string
}) =>
  Object.values(state.cards).some(card =>
    card.sessionIds?.length && canonical({ path: card.agent?.cwd }) === path)

const holds = ({
  state,
  path,
  except,
}: {
  state: HydraState
  path: string
  except?: string
}) =>
  Object.values(state.cards).some(card =>
    card.id !== except && canonical({ path: liveCopy({ card })?.path }) === path)

const idle = ({
  hydraId,
  path,
  except,
}: {
  hydraId: string
  path: string
  except?: string
}) => hydraIds().every(id => {
  const state = loadHydra({ hydraId: id }).state

  return !runsIn({
    state,
    path,
  }) && !holds({
    state,
    path,
    except: id === hydraId ? except : undefined,
  })
})

export function releasedCopyOwner({
  path,
  branch,
}: {
  path: string
  branch: string
}): {
  hydraId: string
  card: Card
} | undefined {
  for (const hydraId of hydraIds()) {
    const owner = Object.values(loadHydra({ hydraId }).state.cards).find(card =>
      card.copy?.state === 'removed' && card.copy.branch === branch && canonical({ path: card.copy.path }) === path)

    if (owner) {
      return {
        hydraId,
        card: owner,
      }
    }
  }

  return undefined
}

// A clean checkout of this project whose commit some branch keeps, so moving it to another branch loses nothing.
export async function reusable({
  path,
  common,
}: {
  path: string
  common: string
}): Promise<boolean> {
  const status = await git({
    cwd: path,
    args: [
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ],
  })

  return status.ok && status.out === '' && await commonDir({ cwd: path }) === common && await onBranch({ cwd: path })
}

export const checkout = ({
  cwd,
  branch,
  start,
  exists,
}: {
  cwd: string
  branch: string
  start: string
  exists: boolean
}) =>
  exists
    ? git({
      cwd,
      args: [
        'switch',
        '--quiet',
        '--no-guess',
        branch,
      ],
    })
    : git({
      cwd,
      args: [
        'checkout',
        '--quiet',
        '--no-track',
        '-b',
        branch,
        start,
      ],
    })

async function claim({
  hydraId,
  task,
  path,
  vacant = false,
}: {
  hydraId: string
  task?: string
  path: string
  vacant?: boolean
}): Promise<boolean> {
  return await withWriter({
    hydraId,
    fn: ({ writer }) => {
      requireUnlinkedCopyFolder({ path: copiesDir() })

      const entry = lstatSync(
        path,
        { throwIfNoEntry: false },
      )

      const available = vacant ? entry === undefined : entry?.isDirectory()

      if (!available || claims.has(path)) {
        return false
      }

      if (!idle({
        hydraId,
        path,
        except: task,
      })) {
        return false
      }

      writer.afterCommit({
        run: () => {
          claims.set(
            path,
            {
              hydraId,
              task,
            },
          )
        },
      })

      return true
    },
  })
}

export function unclaim({ path }: { path: string }): void {
  claims.delete(path)
}

export const reservedCopies = ({ hydraId }: { hydraId: string }): string[] =>
  [...claims].filter(([
    , owner,
  ]) => owner.hydraId !== hydraId).map(([path]) => path)

export const reservingTaskCopy = ({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}): boolean =>
  [...claims.values()].some(owner => owner.hydraId === hydraId && owner.task === task)

export function take({
  hydraId,
  card,
  path,
}: {
  hydraId: string
  card?: Card
  path: string
}): Promise<boolean> {
  return claim({
    hydraId,
    task: card?.id,
    path,
  })
}

export async function freshSlot({
  hydraId,
  task,
  project,
}: {
  hydraId: string
  task: string
  project: HydraProject
}): Promise<string> {
  const pool = copiesDir()

  for (let n = 1; ; n++) {
    const path = join(
      pool,
      `${project.name}-${n}`,
    )

    if (await claim({
      hydraId,
      task,
      path,
      vacant: true,
    })) {
      return path
    }
  }
}

export async function staysInPool({
  hydraId,
  state,
  copy,
}: {
  hydraId: string
  state: HydraState
  copy: TaskCopy
}): Promise<boolean> {
  const project = projectsFor({ state }).find(p => !p.detached && matchesProject({
    project: p,
    ref: copy.project,
  }))
  const path = realpathSync(copy.path)
  const common = project && await commonDir({ cwd: project.path })
  const pooled = project ? slots({
    project,
  }) : []

  if (!common || !pooled.includes(path) || !await reusable({
    path,
    common,
  })) {
    return false
  }

  const spare: string[] = []

  for (const slot of pooled) {
    if (slot !== path && idle({
      hydraId,
      path: slot,
    }) && await reusable({
      path: slot,
      common,
    })) {
      spare.push(slot)
    }
  }

  return runsIn({
    state,
    path,
  }) || spare.length < POOL_IDLE
}

export async function trimPool({ hydraId }: { hydraId: string }): Promise<void> {
  const state = loadHydra({ hydraId }).state

  for (const project of projectsFor({ state }).filter(p => !p.detached)) {
    const pooled = slots({
      project,
    })

    if (!pooled.length) {
      continue
    }

    let kept = 0
    const common = await commonDir({ cwd: project.path })

    for (const path of pooled) {
      if (!await take({
        hydraId,
        path,
      })) {
        continue
      }

      try {
        const branch = (await git({
          cwd: path,
          args: [
            'symbolic-ref',
            '--quiet',
            '--short',
            'HEAD',
          ],
        })).out
        const owner = releasedCopyOwner({
          path,
          branch,
        })?.card

        if (!owner?.copy || owner.copy.project !== project.path || !await reusable({
          path,
          common,
        }) || 'reason' in await checkCopy({
          card: owner,
          copy: owner.copy,
        })) {
          continue
        }

        if (kept++ < POOL_IDLE) {
          continue
        }

        await removeCopy({
          copy: owner.copy,
          force: false,
        })
      } finally {
        unclaim({ path })
      }
    }
  }
}
