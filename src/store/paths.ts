import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export function pnyxHome(): string {
  return process.env.PNYX_HOME || join(
    homedir(),
    '.pnyx',
  )
}

export const taskRuntimeDir = ({ task }: { task: string }) => resolve(
  pnyxHome(),
  'runtime',
  'tasks',
  task,
)

export function within({
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

export function canonical({ path }: { path: unknown }): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return undefined
  }

  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
