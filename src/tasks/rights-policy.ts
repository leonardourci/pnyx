import { lstatSync, existsSync, realpathSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HydraError } from '#store/errors.ts'
import type { Card } from './model.ts'
import { requireTaskRights } from './rights.ts'
import { policyDigest, type NativePolicy } from '#workers/native-policy.ts'

export function taskPolicy({
  card,
  cwd,
  brokerSocket,
  handle,
  cliRoot,
}: {
  card: Card
  cwd: string
  brokerSocket: string
  handle: string
  cliRoot: string
}): NativePolicy | undefined {
  const grant = requireTaskRights({ card })

  if (!grant || !card.rights) {
    return
  }

  const root = realpathSync(cwd)
  const git = join(
    root,
    '.git',
  )

  if (!existsSync(git) || !lstatSync(git).isDirectory() || existsSync(join(
    git,
    'commondir',
  )) || existsSync(join(
    git,
    'objects',
    'info',
    'alternates',
  ))) {
    throw new HydraError({
      code: 'ISOLATED_REPOSITORY_REQUIRED',
      message: 'Restricted tasks need private Git metadata; linked worktrees are unavailable',
    })
  }

  const scratch = join(
    root,
    '.pnyx-runtime',
  )
  mkdirSync(
    scratch,
    {
      recursive: true,
      mode: 0o700,
    },
  )
  const compiled: Omit<NativePolicy, 'digest'> = {
    grant: grant.id,
    revision: card.rights.revision,
    readRoots: [
      root,
      realpathSync(cliRoot),
      '/bin',
      '/usr',
      '/System',
      '/Library/Apple',
      '/opt/homebrew',
      '/dev',
      '/private/var/db',
    ],
    writeRoots: grant.scope.level === 'read-only' ? [] : [root],
    brokerSocket,
    environment: {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: scratch,
      TMPDIR: scratch,
      PNYX_BROKER_SOCKET: brokerSocket,
      PNYX_BROKER_HANDLE: handle,
    },
  }

  return {
    ...compiled,
    digest: policyDigest({ policy: compiled }),
  }
}
