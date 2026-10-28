import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { HydraProject } from './model.ts'

export function canonicalProjectPath({ path }: { path: string }): string | undefined {
  try {
    return realpathSync(resolve(path))
  } catch {
    // Missing projects retain their saved path but cannot establish a new identity.
    return undefined
  }
}

export function sameProjectPath({
  left,
  right,
}: {
  left?: string
  right?: string
}): boolean {
  if (!left || !right) {
    return false
  }

  if (left === right) {
    return true
  }

  const canonicalLeft = canonicalProjectPath({ path: left })
  const canonicalRight = canonicalProjectPath({ path: right })

  return canonicalLeft !== undefined && canonicalLeft === canonicalRight
}

export function matchesProject({
  project,
  ref,
}: {
  project: HydraProject
  ref?: string
}): boolean {
  return project.name === ref || sameProjectPath({
    left: project.path,
    right: ref,
  })
}
