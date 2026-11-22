import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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
