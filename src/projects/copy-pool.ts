import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { matchesProject } from './identity.ts'
import { COPY_TIMEOUT_MS, branchExists, commonDir, git, onBranch } from './git.ts'
import { checkCopy, removeCopy } from './copy-check.ts'
import type { HydraProject, TaskCopy } from './model.ts'
import { projectsFor } from './read.ts'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { isFolder } from '#workers/folders.ts'

// A claim older than the git steps it guards was left by a start that crashed.
const CLAIM_STALE_MS = 2 * COPY_TIMEOUT_MS
export const POOL_IDLE = 2

export const liveCopy = ({ card }: { card: Card }) => (card.copy?.state === 'removed' ? undefined : card.copy)

export const copiesDir = ({ hydraId }: { hydraId: string }) => join(
  hydraDir({ hydraId }),
  'copies',
)

// Slots are named <project>-<n>, so one can pass from task to task.
export function slots({
  hydraId,
  project,
}: {
  hydraId: string
  project: HydraProject
}): string[] {
  const dir = copiesDir({ hydraId })
  const prefix = `${project.name}-`

  if (!isFolder({ path: dir })) {
    return []
  }

  return readdirSync(dir)
    .filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map(name => join(
      dir,
      name,
    ))
    .filter(path => isFolder({ path }))
    .map(path => realpathSync(path))
}

const runsIn = ({
  state,
  path,
}: {
  state: HydraState
  path: string
}) =>
  Object.values(state.cards).some(c => c.sessionIds?.length && c.agent?.cwd === path)

const holds = ({
  state,
  path,
  except,
}: {
  state: HydraState
  path: string
  except?: string
}) =>
  Object.values(state.cards).some(c => c.id !== except && liveCopy({ card: c })?.path === path)

const idle = ({
  state,
  path,
  except,
}: {
  state: HydraState
  path: string
  except?: string
}) =>
  !runsIn({
    state,
    path,
  }) && !holds({
    state,
    path,
    except,
  })

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
    ],
  })

  return status.ok && status.out === '' && await commonDir({ cwd: path }) === common && await onBranch({ cwd: path })
}

export const checkout = async ({
  cwd,
  branch,
  start,
}: {
  cwd: string
  branch: string
  start: string
}) =>
  await branchExists({
    cwd,
    branch,
  })
    ? await git({
      cwd,
      args: [
        'checkout',
        '--quiet',
        branch,
      ],
    })
    : await git({
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

function claimIsStale({ file }: { file: string }): boolean {
  try {
    const pid = Number(readFileSync(
      file,
      'utf8',
    ))

    if (!Number.isInteger(pid) || pid <= 0) {
      return Date.now() - statSync(file).mtimeMs > CLAIM_STALE_MS
    }

    process.kill(
      pid,
      0,
    )

    return false
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ESRCH' || error.code === 'ENOENT') {
        return true
      }

      if (error.code === 'EPERM') {
        return false
      }
    }

    throw error
  }
}

// Claim creation and dead-owner recovery run inside one synchronous write, which the server, the only writer, never
// interleaves with another; Git work stays outside it.
function claim({
  hydraId,
  path,
}: {
  hydraId: string
  path: string
}): boolean {
  return withWriter({
    hydraId,
    fn: () => {
      let fd: number

      try {
        fd = openSync(
          `${path}.claim`,
          'wx',
        )
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
          throw error
        }

        if (!claimIsStale({ file: `${path}.claim` })) {
          return false
        }

        rmSync(
          `${path}.claim`,
          { force: true },
        )
        fd = openSync(
          `${path}.claim`,
          'wx',
        )
      }

      try {
        writeFileSync(
          fd,
          String(process.pid),
        )
      } finally {
        closeSync(fd)
      }

      return true
    },
  })
}

export const unclaim = ({ path }: { path: string }) => rmSync(
  `${path}.claim`,
  { force: true },
)

// Claiming first means the idle check sees every record a competing start wrote before letting go.
export function take({
  hydraId,
  card,
  path,
}: {
  hydraId: string
  card?: Card
  path: string
}): boolean {
  if (!claim({
    hydraId,
    path,
  })) {
    return false
  }

  if (idle({
    state: loadHydra({ hydraId }).state,
    path,
    except: card?.id,
  })) {
    return true
  }

  unclaim({ path })

  return false
}

export function freshSlot({
  hydraId,
  project,
}: {
  hydraId: string
  project: HydraProject
}): string {
  for (let n = 1; ; n++) {
    const path = join(
      copiesDir({ hydraId }),
      `${project.name}-${n}`,
    )

    if (!existsSync(path) && claim({
      hydraId,
      path,
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
    hydraId,
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
      state,
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
      hydraId,
      project,
    })

    if (!pooled.length) {
      continue
    }

    let kept = 0
    const common = await commonDir({ cwd: project.path })

    for (const path of slots({
      hydraId,
      project,
    })) {
      if (!take({
        hydraId,
        path,
      })) {
        continue
      }

      try {
        const current = loadHydra({ hydraId }).state
        const branch = (await git({
          cwd: path,
          args: [
            'symbolic-ref',
            '--quiet',
            '--short',
            'HEAD',
          ],
        })).out
        const owner = Object.values(current.cards).find(c => c.copy?.path === path
          && c.copy.state === 'removed' && c.copy.project === project.path && c.copy.branch === branch)

        if (!owner?.copy || !await reusable({
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
