import { canonicalProjectPath, sameProjectPath } from './identity.ts'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { TitanState } from '#app/model.ts'
import { TitanError } from '#store/errors.ts'
import type { TitanProject } from './model.ts'
import { landingRule } from '#tasks/delivery/model.ts'
import { titanConfig } from '#titan/config.ts'
import { titanIds } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'

export function projectsFor({ state }: { state: TitanState }): TitanProject[] {
  return [...state.projects ?? []].sort((
    a,
    b,
  ) => Number(a.detached) - Number(b.detached)
    || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

export function projectRows({
  state,
  projects = projectsFor({ state }),
}: {
  state: TitanState
  projects?: TitanProject[]
}) {
  return projects.map(p => ({
    name: p.name,
    path: p.path,
    state: p.detached ? 'detached' : 'attached',
    ...landingRule({ project: p }),
    ...(p.startCommand ? { startCommand: p.startCommand } : {}),
  }))
}

export function findProject({
  state,
  ref,
  attached = false,
  projects = projectsFor({ state }),
}: {
  state: TitanState
  ref: string
  attached?: boolean
  projects?: TitanProject[]
}): TitanProject {
  const candidates = projects.filter(p => !attached || !p.detached)
  const pathRef = ref.includes('/') || ref === '.' || ref === '..'
  const exact = candidates.find(p => p.path === ref || (pathRef && sameProjectPath({
    left: p.path,
    right: ref,
  })))
  const matches = exact ? [exact] : candidates.filter(p => p.name === ref)

  const [
    project,
    ...others
  ] = matches

  if (!project || others.length) {
    throw new TitanError({
      message: matches.length ? `project name is ambiguous: ${ref}; use its full path` : 'project not found',
      code: matches.length ? 'CONFLICT' : 'NOT_FOUND',
    })
  }

  return project
}

// A new task's project must be one attached to the Titan; the task records its path.
export function taskProject({
  state,
  ref,
}: {
  state: TitanState
  ref: string
}): string {
  let selected: TitanProject

  try {
    selected = findProject({
      state,
      ref,
    })
  } catch (error) {
    if (error instanceof TitanError && error.code === 'NOT_FOUND') {
      throw new TitanError({
        message: `project not attached: ${ref}`,
        code: 'NOT_FOUND',
        help: ['Run `othrys project list` for attached projects. Attach a project in the UI.'],
      })
    }

    throw error
  }

  if (selected.detached) {
    throw new TitanError({
      message: `project is detached: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Re-attach the project before selecting it for new work'],
    })
  }

  return selected.path
}

export function projectFolder({ path }: { path: string }): string {
  try {
    const real = canonicalProjectPath({ path })

    if (real && statSync(real).isDirectory()) {
      return real
    }
  } catch { /* Missing paths cannot be attached. */ }

  throw new TitanError({
    message: `project folder not found: ${path}`,
    code: 'NOT_FOUND',
  })
}

export function sharingTitans({
  titanId,
  path,
}: {
  titanId: string
  path: string
}) {
  return titanIds().filter(id => id !== titanId)
    .flatMap(id => {
      const state = loadTitan({ titanId: id }).state

      if (!projectsFor({ state }).some(p => !p.detached && sameProjectPath({
        left: p.path,
        right: path,
      }))) {
        return []
      }

      return [
        {
          id,
          name: titanConfig({
            state,
            id,
          }).name,
          url: `/titan/${encodeURIComponent(id)}/`,
        },
      ]
    })
}

export const projectName = ({ path }: { path: string }) => basename(path) || path
