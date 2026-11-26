import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const othrysHome = (): string => process.env.OTHRYS_HOME || resolve(
  homedir(),
  '.othrys',
)

export const taskRuntimeDir = ({ task }: { task: string }) => resolve(
  othrysHome(),
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

export const homeScoped = ({ hydraId }: { hydraId: string }) => {
  const home = resolve(othrysHome())

  return `${canonical({ path: home }) ?? home}\u0000${hydraId}`
}
