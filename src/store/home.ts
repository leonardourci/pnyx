import { accessSync, constants, lstatSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { TitanError } from './errors.ts'

function present({ path }: { path: string }): boolean {
  try {
    lstatSync(path)

    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

function requireDirectory({ path }: { path: string }) {
  if (!statSync(path).isDirectory()) {
    throw new Error(`Home is not a directory: ${path}`)
  }

  accessSync(
    path,
    constants.R_OK | constants.W_OK | constants.X_OK,
  )
}

export function selectHome({
  env,
  userHome,
}: {
  env: NodeJS.ProcessEnv
  userHome: string
}): string {
  const explicit = env.OTHRYS_HOME || env.PNYX_HOME

  if (explicit) {
    return explicit
  }

  const home = join(
    userHome,
    '.othrys',
  )
  const legacy = join(
    userHome,
    '.pnyx',
  )

  try {
    if (present({ path: home })) {
      requireDirectory({ path: home })

      return home
    }

    if (!present({ path: legacy })) {
      return home
    }

    requireDirectory({ path: legacy })

    try {
      symlinkSync(
        legacy,
        home,
        'dir',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      requireDirectory({ path: home })
    }

    return home
  } catch (cause) {
    throw new TitanError({
      code: 'HOME_MIGRATION_FAILED',
      message: `Cannot select Othrys home ${home}: ${(cause as Error).message}`,
      help: ['Check the home directory and symlink permissions, or set OTHRYS_HOME explicitly. Existing data was not merged or removed.'],
      cause,
    })
  }
}
