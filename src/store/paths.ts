import { selectHome } from './home.ts'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

let selected: {
  key: string
  home: string
} | undefined

// Selecting the default home checks the file system, so a process keeps the answer until its inputs change.
export function othrysHome(): string {
  const key = [
    process.env.OTHRYS_HOME,
    process.env.PNYX_HOME,
    homedir(),
  ].join('\0')

  if (selected?.key !== key) {
    selected = {
      key,
      home: selectHome({
        env: process.env,
        userHome: homedir(),
      }),
    }
  }

  return selected.home
}

// The home's hydras folder under each name it has, since a ~/.othrys alias and its ~/.pnyx target hold the same files.
export const hydrasFolders = (): string[] => [
  ...new Set([
    othrysHome(),
    canonical({ path: othrysHome() }) ?? othrysHome(),
  ]),
].map(home => resolve(
  home,
  'hydras',
))

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
