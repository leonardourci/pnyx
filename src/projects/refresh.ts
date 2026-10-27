import { execFile } from 'node:child_process'
import { watchPath } from '../runtime/watch.ts'
import { readlink, realpath, stat, symlink, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ProjectRefresh } from './refresh-types.ts'

const runFile = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000
const GIT_OUTPUT_BYTES = 1024 * 1024
const repositoryTurns = new Map<string, Promise<void>>()

interface RefreshLockWait {
  now(): number
  schedule({
    ms,
    fire,
  }: {
    ms: number
    fire(): void
  }): () => void
}

const systemLockWait: RefreshLockWait = {
  now: () => Date.now(),
  schedule: ({
    ms,
    fire,
  }) => {
    const timer = setTimeout(
      fire,
      ms,
    )

    return () => clearTimeout(timer)
  },
}

async function git({
  path,
  args,
}: {
  path: string
  args: string[]
}): Promise<string> {
  const result = await runFile(
    'git',
    [
      '--no-optional-locks',
      '-C',
      path,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'merge.autoStash=false',
      '-c',
      'submodule.recurse=false',
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_BYTES,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  )

  return result.stdout.trim()
}

async function acquireRefreshLock({
  path,
  token,
  wait,
}: {
  path: string
  token: string
  wait: RefreshLockWait
}): Promise<boolean> {
  const deadline = wait.now() + GIT_TIMEOUT_MS

  let owner: string | undefined
  const timedOut = () => new Error(`timed out waiting for the active project refresh after ${GIT_TIMEOUT_MS}ms: ${path} (owner: ${owner ?? 'unknown'}); inspect its lock owner`)

  while (wait.now() < deadline) {
    try {
      await symlink(
        token,
        path,
      )

      return true
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error
      }
    }

    let notify = () => {}
    let failure: Error | undefined
    const changed = new Promise<void>(resolve => {
      notify = resolve
    })
    const watcher = watchPath({
      path: dirname(path),
      changed: ({ filename }) => {
        if (!filename || filename === basename(path)) {
          notify()
        }
      },
    })
    let cancel = () => {}

    try {
      try {
        owner = await readlink(path)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          continue
        }

        return false
      }

      const ownerPid = /^pnyx-refresh:(\d+):/.exec(owner)?.[1]

      if (!ownerPid) {
        return false
      }

      try {
        process.kill(
          Number(ownerPid),
          0,
        )
      } catch {
        return false
      }

      cancel = wait.schedule({
        fire: () => {
          failure = timedOut()
          notify()
        },
        ms: Math.max(
          1,
          deadline - wait.now(),
        ),
      })

      await changed

      if (failure) {
        throw failure
      }
    } finally {
      cancel()
      watcher.close()
    }
  }

  throw timedOut()
}

async function advanceProject({
  result,
  isPending,
}: {
  result: ProjectRefresh
  isPending(): boolean
}): Promise<void> {
  const path = result.path
  result.before = await git({
    path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  result.after = result.before
  const branchRef = await git({
    path,
    args: [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ],
  })
  result.branch = branchRef
  const gitDirectory = await git({
    path,
    args: [
      'rev-parse',
      '--absolute-git-dir',
    ],
  })

  for (const operation of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'BISECT_LOG',
  ]) {
    try {
      await stat(join(
        gitDirectory,
        operation,
      ))
      result.state = 'needs-attention'
      result.reason = `local copy has an unfinished Git operation (${operation}); finish it before refreshing`

      return
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  const remotes = (await git({
    path,
    args: ['remote'],
  })).split('\n').filter(Boolean)
  let configuredRemote = ''

  try {
    configuredRemote = await git({
      path,
      args: [
        'config',
        '--get-regexp',
        '^branch\\..*\\.remote$',
      ],
    })
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 1) {
      throw error
    }
  }

  const branchRemote = configuredRemote.split('\n').find(line => line.startsWith(`branch.${branchRef}.remote `))
    ?.split(' ')[1]
  let remote = branchRemote

  if (!remote && remotes.includes('origin')) {
    remote = 'origin'
  }

  if (!remote && remotes.length === 1) {
    remote = remotes[0]
  }

  if (!remote || remote === '.' || !remotes.includes(remote)) {
    result.reason = 'cannot identify one configured remote; configure the project remote and refresh manually'

    return
  }

  result.remote = remote
  const advertised = await git({
    path,
    args: [
      'ls-remote',
      '--symref',
      remote,
      'HEAD',
    ],
  })
  const defaultBranch = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(advertised)?.[1]

  if (!defaultBranch) {
    result.reason = `remote ${remote} did not advertise its default branch; check its HEAD configuration`

    return
  }

  result.defaultBranch = defaultBranch
  const trackingRef = `refs/remotes/${remote}/${defaultBranch}`
  await git({
    path,
    args: [
      'fetch',
      '--quiet',
      '--no-tags',
      remote,
      `refs/heads/${defaultBranch}:${trackingRef}`,
    ],
  })
  result.target = await git({
    path,
    args: [
      'rev-parse',
      '--verify',
      `${trackingRef}^{commit}`,
    ],
  })
  result.state = 'needs-attention'
  const dirty = await git({
    path,
    args: [
      'status',
      '--porcelain',
      '--untracked-files=all',
    ],
  })

  if (dirty) {
    result.reason = 'local copy has uncommitted or untracked files; commit or move them before refreshing'

    return
  }

  if (branchRef !== defaultBranch) {
    const worktrees = await git({
      path,
      args: [
        'worktree',
        'list',
        '--porcelain',
      ],
    })
    const checkedElsewhere = worktrees.includes(`branch refs/heads/${defaultBranch}\n`)
    result.reason = `local copy is on ${branchRef}; select ${defaultBranch} manually before refreshing`

    if (branchRef === 'HEAD') {
      let detachedReason = 'local copy has a detached HEAD'

      if (checkedElsewhere) {
        detachedReason += `; ${defaultBranch} is checked out in another worktree`
      }

      result.reason = `${detachedReason}; select the default branch manually`
    }

    return
  }

  if (result.before === result.target) {
    result.state = 'current'

    return
  }

  try {
    await git({
      path,
      args: [
        'merge-base',
        '--is-ancestor',
        result.before,
        result.target,
      ],
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) {
      result.reason = `local ${defaultBranch} has commits outside ${remote}/${defaultBranch}; reconcile them manually`

      return
    }

    throw error
  }

  const currentHead = await git({
    path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  const currentBranch = await git({
    path,
    args: [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ],
  })
  const currentFiles = await git({
    path,
    args: [
      'status',
      '--porcelain',
      '--untracked-files=all',
    ],
  })

  if (currentHead !== result.before || currentBranch !== defaultBranch || currentFiles) {
    result.reason = 'local copy changed during refresh; inspect it and refresh manually'

    return
  }

  if (!isPending()) {
    return
  }

  await git({
    path,
    args: [
      'merge',
      '--ff-only',
      '--no-edit',
      '--no-overwrite-ignore',
      result.target,
    ],
  })
  result.after = await git({
    path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  result.state = result.after === result.target ? 'advanced' : 'unknown'

  if (result.state === 'unknown') {
    result.reason = 'could not confirm the local copy reached the fetched default; inspect its HEAD'
  }

  return
}

export async function refreshProject({
  path,
  url,
  merge,
  isPending,
  complete,
  lockWait = systemLockWait,
}: {
  path: string
  url: string
  merge: string
  isPending(): boolean
  lockWait?: RefreshLockWait
  complete({ result }: { result: ProjectRefresh }): void
}): Promise<void> {
  const result: ProjectRefresh = {
    path,
    url,
    merge,
    state: 'unknown',
  }
  let release: (() => void) | undefined
  let turn: Promise<void> | undefined
  let ownsLock = false
  let performed = true
  const token = `pnyx-refresh:${process.pid}:${randomUUID()}`
  let lockPath: string | undefined

  try {
    result.path = await realpath(path)
    const root = await realpath(await git({
      path: result.path,
      args: [
        'rev-parse',
        '--show-toplevel',
      ],
    }))

    if (root !== result.path) {
      result.reason = 'registered project is not the repository root; attach its root before refreshing'

      return
    }

    result.repository = await realpath(await git({
      path: result.path,
      args: [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ],
    }))
    const previous = repositoryTurns.get(result.repository)
    turn = new Promise<void>(resolve => {
      release = resolve
    })
    repositoryTurns.set(
      result.repository,
      turn,
    )

    if (previous) {
      await previous
    }

    lockPath = join(
      result.repository,
      'pnyx-project-refresh.lock',
    )

    ownsLock = await acquireRefreshLock({
      path: lockPath,
      token,
      wait: lockWait,
    })

    if (!ownsLock) {
      result.state = 'needs-attention'
      result.reason = `another refresh holds ${lockPath}; check its owner before refreshing manually`

      return
    }

    if (!isPending()) {
      performed = false

      return
    }

    await advanceProject({
      result,
      isPending,
    })
  } catch (error) {
    result.state = 'unknown'
    const detail = error instanceof Error ? error.message : String(error)
    result.reason = `refresh failed; inspect the local copy and remote before refreshing manually: ${detail.slice(
      0,
      GIT_OUTPUT_BYTES,
    )}`
  } finally {
    try {
      if (performed) {
        complete({ result })
      }
    } finally {
      if (ownsLock && lockPath) {
        try {
          if (await readlink(lockPath) === token) {
            await unlink(lockPath)
          }
        } catch (error) {
          console.error(`pnyx-axi project refresh lock: ${String(error)}`)
        }
      }

      release?.()

      if (result.repository && repositoryTurns.get(result.repository) === turn) {
        repositoryTurns.delete(result.repository)
      }
    }
  }
}
