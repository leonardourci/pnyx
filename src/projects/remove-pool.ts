import { existsSync, lstatSync, realpathSync, rmdirSync, readdirSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { HydraError } from '#store/errors.ts'
import { copiesDir } from './copy-pool.ts'
import { commonDir, git } from './git.ts'

function within({
  root,
  path,
}: {
  root: string
  path: string
}): boolean {
  const part = relative(
    root,
    path,
  )

  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

const canonicalPath = ({ path }: { path: string }) =>
  existsSync(path) ? realpathSync(path) : resolve(path)

export function protectedCopiesFolder({
  hydraId,
  root = copiesDir({ hydraId }),
  preserveSurvivors = true,
}: {
  hydraId: string
  root?: string
  preserveSurvivors?: boolean
}) {
  if (lstatSync(
    root,
    { throwIfNoEntry: false },
  )?.isSymbolicLink()) {
    throw new HydraError({
      message: `Copies folder is a symbolic link: ${root}`,
      code: 'CONFLICT',
    })
  }

  const folder = canonicalPath({ path: root })

  const survivors: string[] = []

  for (const id of hydraIds()) {
    const current = loadHydra({ hydraId: id }).state
    const projects = current.projects ?? []
    const sourcePaths = Object.values(current.cards).flatMap(card =>
      card.copy ? [card.copy.project] : [])
    const protectedPaths = [
      ...projects.map(project => project.path),
      ...sourcePaths,
    ]

    if (id !== hydraId) {
      survivors.push(...Object.values(current.cards).flatMap(card =>
        card.copy && card.copy.state !== 'removed' ? [canonicalPath({ path: card.copy.path })] : []))
    }

    for (const path of protectedPaths) {
      const insideRoot = within({
        root: resolve(root),
        path: resolve(path),
      })
      const insideFolder = within({
        root: folder,
        path: canonicalPath({ path }),
      })

      if (insideRoot || insideFolder) {
        throw new HydraError({
          message: `Copies folder contains a project or another Hydra’s copy: ${path}`,
          code: 'CONFLICT',
        })
      }
    }
  }

  const overlapsSurvivor = survivors.some(path =>
    within({
      root: folder,
      path,
    }) || within({
      root: path,
      path: folder,
    }))

  if (!preserveSurvivors && overlapsSurvivor) {
    throw new HydraError({
      message: `Copy overlaps another Hydra’s checkout: ${root}`,
      code: 'CONFLICT',
    })
  }

  return {
    root,
    folder,
    survivors,
  }
}

export async function hydraPool({ hydraId }: { hydraId: string }) {
  const {
    root,
    folder,
    survivors,
  } = protectedCopiesFolder({ hydraId })
  const state = loadHydra({ hydraId }).state
  const attachedProjects = state.projects ?? []
  const copies = Object.values(state.cards).flatMap(card => card.copy ? [card.copy] : [])
  const projects = new Set([
    ...attachedProjects.map(project => project.path),
    ...copies.map(copy => copy.project),
  ])
  const slots: {
    project: string
    path: string
  }[] = []
  const repositories = new Set<string>()

  for (const project of projects) {
    const common = await commonDir({ cwd: project })

    if (!common) {
      const worktree = copies.some(copy => copy.project === project && copy.via === 'worktree'
        && (existsSync(copy.path) || existsSync(project)))

      if (worktree) {
        throw new HydraError({
          message: `Cannot read the worktrees of ${project}`,
          code: 'CONFLICT',
        })
      }

      continue
    }

    if (repositories.has(common)) {
      continue
    }

    repositories.add(common)
    const listed = await git({
      cwd: project,
      args: [
        'worktree',
        'list',
        '--porcelain',
        '-z',
      ],
    })

    if (!listed.ok) {
      throw new HydraError({
        message: listed.err,
        code: 'CONFLICT',
      })
    }

    for (const field of listed.out.split('\0')) {
      if (!field.startsWith('worktree ')) {
        continue
      }

      const path = field.slice('worktree '.length)
      const canonical = canonicalPath({ path })
      const insideRoot = within({
        root: resolve(root),
        path: resolve(path),
      })
        || within({
          root: folder,
          path: resolve(path),
        })
      const insideFolder = within({
        root: folder,
        path: canonical,
      })

      if (insideRoot !== insideFolder && existsSync(path)) {
        throw new HydraError({
          message: `Worktree crosses the copies folder boundary: ${path}`,
          code: 'CONFLICT',
        })
      }

      const survives = survivors.some(survivor => within({
        root: canonical,
        path: survivor,
      }) || within({
        root: survivor,
        path: canonical,
      }))

      if (insideRoot && (insideFolder || !existsSync(path)) && !survives) {
        slots.push({
          project,
          path,
        })
      }
    }
  }

  return {
    root,
    folder,
    slots,
  }
}

export async function removeHydraPool({
  hydraId,
  verify,
}: {
  hydraId: string
  verify?({ path }: { path: string }): Promise<void>
}): Promise<void> {
  const pool = await hydraPool({ hydraId })

  function validateFolder() {
    const current = protectedCopiesFolder({ hydraId })

    if (current.folder !== pool.folder) {
      throw new HydraError({
        message: `Copies folder changed during removal: ${pool.root}`,
        code: 'CONFLICT',
      })
    }
  }

  for (const slot of pool.slots) {
    await verify?.({ path: slot.path })
    protectedCopiesFolder({
      hydraId,
      root: slot.path,
      preserveSurvivors: false,
    })
    validateFolder()

    if (existsSync(slot.path) && !within({
      root: pool.folder,
      path: canonicalPath({ path: slot.path }),
    })) {
      throw new HydraError({
        message: `Worktree resolves outside the copies folder: ${slot.path}`,
        code: 'CONFLICT',
      })
    }

    const removed = await git({
      cwd: slot.project,
      args: [
        'worktree',
        'remove',
        '--force',
        slot.path,
      ],
    })

    if (!removed.ok) {
      throw new HydraError({
        message: `${slot.path}: git could not remove the worktree (${removed.err})`,
        code: 'CONFLICT',
      })
    }
  }

  validateFolder()

  const { survivors } = protectedCopiesFolder({ hydraId })

  function removeEmptyFolders({ path }: { path: string }) {
    const info = lstatSync(
      path,
      { throwIfNoEntry: false },
    )

    if (!info?.isDirectory()) {
      return
    }

    const canonical = canonicalPath({ path })

    if (survivors.some(survivor => within({
      root: survivor,
      path: canonical,
    }))) {
      return
    }

    for (const entry of readdirSync(path)) {
      removeEmptyFolders({
        path: resolve(
          path,
          entry,
        ),
      })
    }

    if (readdirSync(path).length === 0) {
      rmdirSync(path)
    }
  }

  removeEmptyFolders({ path: pool.root })
}
