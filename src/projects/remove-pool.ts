import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs'
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

  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

const canonicalPath = ({ path }: { path: string }) =>
  existsSync(path) ? realpathSync(path) : resolve(path)

export async function hydraPool({ hydraId }: { hydraId: string }) {
  const root = copiesDir({ hydraId })

  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new HydraError({
      message: `Copies folder is a symbolic link: ${root}`,
      code: 'CONFLICT',
    })
  }

  const folder = canonicalPath({ path: root })
  const state = loadHydra({ hydraId }).state
  const projects = new Set([
    ...state.projects?.map(project => project.path) ?? [],
    ...Object.values(state.cards).flatMap(card => card.copy ? [card.copy.project] : []),
  ])

  for (const id of hydraIds()) {
    const current = id === hydraId ? state : loadHydra({ hydraId: id }).state
    const protectedPaths = current.projects?.map(project => project.path) ?? []

    if (id !== hydraId) {
      protectedPaths.push(...Object.values(current.cards).flatMap(card =>
        card.copy && card.copy.state !== 'removed' ? [card.copy.path] : []))
    }

    for (const path of protectedPaths) {
      if (within({
        root: folder,
        path: canonicalPath({ path }),
      })) {
        throw new HydraError({
          message: `Copies folder contains a project or another Hydra’s copy: ${path}`,
          code: 'CONFLICT',
        })
      }
    }
  }

  const slots: {
    project: string
    path: string
  }[] = []
  const repositories = new Set<string>()

  for (const project of projects) {
    const common = await commonDir({ cwd: project })

    if (!common) {
      const worktree = Object.values(state.cards).some(card => card.copy?.project === project && card.copy.via === 'worktree')

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

      if (within({
        root: folder,
        path: resolve(path),
      }) && !within({
        root: folder,
        path: canonical,
      })) {
        throw new HydraError({
          message: `Worktree resolves outside the copies folder: ${path}`,
          code: 'CONFLICT',
        })
      }

      if (within({
        root: folder,
        path: canonical,
      })) {
        slots.push({
          project,
          path,
        })
      }
    }
  }

  return {
    root,
    slots,
  }
}

export async function removeHydraPool({ hydraId }: { hydraId: string }): Promise<void> {
  const pool = await hydraPool({ hydraId })

  for (const slot of pool.slots) {
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
        message: removed.err,
        code: 'CONFLICT',
      })
    }
  }

  rmSync(
    pool.root,
    {
      recursive: true,
      force: true,
    },
  )
}
