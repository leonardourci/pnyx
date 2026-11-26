import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { matchesProject, sameProjectPath } from './identity.ts'
import { commonDir, git, onBranch } from './git.ts'
import { checkCopy, removeCopy } from './copy-check.ts'
import type { TitanProject, TaskCopy } from './model.ts'
import { projectsFor } from './read.ts'
import type { TitanState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { othrysHome } from '#store/storage.ts'
import { canonical, within } from '#store/paths.ts'
import { TitanError } from '#store/errors.ts'
import { isFolder } from '#workers/folders.ts'

const claims = new Map<string, {
  titanId: string
  task?: string
}>()
const POOL_IDLE = 2

export const liveCopy = ({ card }: { card: Card }) => (card.copy?.state === 'removed' ? undefined : card.copy)

// An unnamed Titan names its task branches after its id.
export const branchTitanName = ({
  titanId,
  state,
}: {
  titanId: string
  state: TitanState
}) => state.config?.name || titanId

export function recordedBranches({
  titanId,
  state,
  project,
}: {
  titanId: string
  state: TitanState
  project: string
}): string[] {
  const branches = new Set<string>()

  for (const id of hydraIds()) {
    const current = id === titanId ? state : loadTitan({ titanId: id }).state

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
  const home = resolve(othrysHome())

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
    throw new TitanError({
      message: `Copies folder is a symbolic link: ${path}`,
      code: 'CONFLICT',
    })
  }
}

export function slots({
  project,
}: {
  project: TitanProject
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
  state: TitanState
  path: string
}) =>
  Object.values(state.cards).some(card => {
    const cwd = canonical({ path: card.agent?.cwd })

    return card.sessionIds?.length && cwd !== undefined && within({
      root: path,
      path: cwd,
    })
  })

const holds = ({
  state,
  path,
  except,
}: {
  state: TitanState
  path: string
  except?: string
}) =>
  Object.values(state.cards).some(card =>
    card.id !== except && canonical({ path: liveCopy({ card })?.path }) === path)

const idle = ({
  titanId,
  path,
  except,
}: {
  titanId: string
  path: string
  except?: string
}) => hydraIds().every(id => {
  const state = loadTitan({ titanId: id }).state

  return !runsIn({
    state,
    path,
  }) && !holds({
    state,
    path,
    except: id === titanId ? except : undefined,
  })
})

export function releasedCopyOwner({
  path,
  branch,
}: {
  path: string
  branch: string
}): {
  titanId: string
  card: Card
} | undefined {
  for (const titanId of hydraIds()) {
    const owner = Object.values(loadTitan({ titanId }).state.cards).find(card =>
      card.copy?.state === 'removed' && card.copy.branch === branch && canonical({ path: card.copy.path }) === path)

    if (owner) {
      return {
        titanId,
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
  titanId,
  task,
  path,
  vacant = false,
}: {
  titanId: string
  task?: string
  path: string
  vacant?: boolean
}): Promise<boolean> {
  return await withWriter({
    titanId,
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
        titanId,
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
              titanId,
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

export const reservedCopies = ({ titanId }: { titanId: string }): string[] =>
  [...claims].filter(([
    , owner,
  ]) => owner.titanId !== titanId).map(([path]) => path)

export const reservingTaskCopy = ({
  titanId,
  task,
}: {
  titanId: string
  task: string
}): boolean =>
  [...claims.values()].some(owner => owner.titanId === titanId && owner.task === task)

export function take({
  titanId,
  card,
  path,
}: {
  titanId: string
  card?: Card
  path: string
}): Promise<boolean> {
  return claim({
    titanId,
    task: card?.id,
    path,
  })
}

export async function freshSlot({
  titanId,
  task,
  project,
}: {
  titanId: string
  task: string
  project: TitanProject
}): Promise<string> {
  const pool = copiesDir()

  for (let n = 1; ; n++) {
    const path = join(
      pool,
      `${project.name}-${n}`,
    )

    if (await claim({
      titanId,
      task,
      path,
      vacant: true,
    })) {
      return path
    }
  }
}

export async function staysInPool({
  titanId,
  state,
  copy,
}: {
  titanId: string
  state: TitanState
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
      titanId,
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

export async function trimPool({ titanId }: { titanId: string }): Promise<void> {
  const state = loadTitan({ titanId }).state

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
        titanId,
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
