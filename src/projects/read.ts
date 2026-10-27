import { canonicalProjectPath, sameProjectPath } from './identity.ts'
import { projectLabel } from '../core/decide.ts'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { HydraError, landingRule, type HydraProject } from '../core/model.ts'
import { type HydraState } from '../app/model.ts'
import { hydraConfig } from '../core/hydra.ts'
import { loadHydra } from '../app/store.ts'
import { hydraIds } from '../app/home-migration.ts'
import { firstmateProjects } from '../integrations/firstmate/projects.ts'

export function projectsFor({
  state,
  aliases = false,
}: {
  state: HydraState
  aliases?: boolean
}): (HydraProject & { aliases?: string[] })[] {
  const hydra = state.config?.hydra
  const projects = hydra?.kind === 'firstmate' && hydra.home
    ? firstmateProjects({
      home: hydra.home,
      aliases,
    }) : state.projects ?? []

  return [...projects].sort((
    a,
    b,
  ) => Number(a.detached) - Number(b.detached)
    || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

export function projectRows({ state }: { state: HydraState }) {
  return projectsFor({ state }).map(p => ({
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
}: {
  state: HydraState
  ref: string
  attached?: boolean
}): HydraProject {
  const projects = projectsFor({ state }).filter(p => !attached || !p.detached)
  const pathRef = ref.includes('/') || ref === '.' || ref === '..'
  const exact = projects.find(p => p.path === ref || (pathRef && sameProjectPath({
    left: p.path,
    right: ref,
  })))
  const matches = exact ? [exact] : projects.filter(p => p.name === ref)

  const [
    project,
    ...others
  ] = matches

  if (!project || others.length) {
    throw new HydraError({
      message: matches.length ? `project name is ambiguous: ${ref}; use its full path` : `project not found: ${ref}`,
      code: matches.length ? 'CONFLICT' : 'NOT_FOUND',
    })
  }

  return project
}

export function taskProject({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): string | null {
  let selected: HydraProject | undefined

  try {
    selected = findProject({
      state,
      ref,
    })
  } catch (error) {
    if (!(error instanceof HydraError) || error.code !== 'NOT_FOUND') {
      throw error
    }
  }

  if (selected?.detached) {
    throw new HydraError({
      message: `project is detached: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Re-attach the project before selecting it for new work'],
    })
  }

  return selected?.path ?? projectLabel({ value: ref })
}

export function projectFolder({ path }: { path: string }): string {
  try {
    const real = canonicalProjectPath({ path })

    if (real && statSync(real).isDirectory()) {
      return real
    }
  } catch { /* Missing paths cannot be attached. */ }

  throw new HydraError({
    message: `project folder not found: ${path}`,
    code: 'NOT_FOUND',
  })
}

export function sharingHydras({
  hydraId,
  path,
}: {
  hydraId: string
  path: string
}) {
  return hydraIds().filter(id => id !== hydraId)
    .flatMap(id => {
      const state = loadHydra({ hydraId: id }).state

      if (!projectsFor({ state }).some(p => !p.detached && sameProjectPath({
        left: p.path,
        right: path,
      }))) {
        return []
      }

      return [
        {
          id,
          name: hydraConfig({
            state,
            id,
          }).name,
          url: `/hydra/${encodeURIComponent(id)}/`,
        },
      ]
    })
}

export const projectName = ({ path }: { path: string }) => basename(path) || path
