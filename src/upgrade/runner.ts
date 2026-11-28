import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { log } from '#app/diagnostics.ts'
import { runFile } from '#app/run-process.ts'
import { replaceFile } from '#store/storage.ts'
import type { UpgradeChannel, UpgradeOperation, UpgradeStep, UpgradeStepName } from './model.ts'

export const OTHRYS_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
)

const NETWORK_MS = 60_000
const BUILD_MS = 15 * 60_000
const MAIN = 'refs/heads/main'
const RELEASE_TAG = /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const NO_RELEASE = 'origin has no release tag yet. Set upgradeChannel to development to follow main.'

// The last lines of a failed command, enough to recognize the error.
const excerpt = ({ text }: { text: string }) => text.split('\n').map(line => line.trimEnd())
  .filter(Boolean)
  .slice(-8)
  .join('\n')
  .slice(-1000)

async function run({
  root,
  command,
  args,
  timeout = NETWORK_MS,
  env,
  signal,
}: {
  root: string
  command: string
  args: string[]
  timeout?: number
  env?: Record<string, string>
  signal?: AbortSignal
}): Promise<string> {
  try {
    const { stdout } = await runFile({
      command,
      args,
      options: {
        cwd: root,
        timeout,
        signal,
        maxBuffer: 64 * 1024 * 1024,
        // A remote that wants a login fails instead of waiting on a prompt nobody sees.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
          ...env,
        },
      },
    })

    return stdout.trimEnd()
  } catch (error) {
    const failed = error as Error & {
      stdout?: string
      stderr?: string
    }

    throw new Error(
      excerpt({ text: `${failed.stdout ?? ''}\n${failed.stderr ?? ''}` }) || failed.message,
      { cause: error },
    )
  }
}

const git = ({
  root,
  args,
  signal,
}: {
  root: string
  args: string[]
  signal?: AbortSignal
}) => run({
  root,
  command: 'git',
  args,
  signal,
})

// pnpm stops to ask before replacing node_modules unless it knows no one can answer.
const pnpm = ({
  root,
  args,
  signal,
}: {
  root: string
  args: string[]
  signal?: AbortSignal
}) => run({
  root,
  command: 'pnpm',
  args,
  timeout: BUILD_MS,
  env: { CI: 'true' },
  signal,
})

interface RemoteTarget {
  ref: string
  commit: string
}

const newerVersion = ({
  version,
  than,
}: {
  version: bigint[]
  than: bigint[]
}) => {
  const differing = version.findIndex((
    part,
    index,
  ) => part !== than[index])

  return differing !== -1 && version[differing] > than[differing]
}

async function newestRelease({
  root,
  signal,
}: {
  root: string
  signal?: AbortSignal
}): Promise<RemoteTarget | undefined> {
  const listed = await git({
    root,
    signal,
    args: [
      'ls-remote',
      '--tags',
      'origin',
      'v*',
    ],
  })
  const commits = new Map<string, string>()

  for (const line of listed.split('\n')) {
    const [commit, ref] = line.split('\t')

    if (commit && ref) {
      commits.set(ref, commit)
    }
  }

  let newest: {
    ref: string
    commit: string
    version: bigint[]
  } | undefined

  for (const [ref, object] of commits) {
    const version = RELEASE_TAG.exec(ref)?.slice(1)
      .map(part => BigInt(part))

    if (version && (!newest || newerVersion({
      version,
      than: newest.version,
    }))) {
      newest = {
        ref,
        commit: commits.get(`${ref}^{}`) ?? object,
        version,
      }
    }
  }

  if (!newest) {
    return undefined
  }

  return {
    ref: newest.ref,
    commit: newest.commit,
  }
}

async function remoteTarget({
  root,
  channel,
  signal,
}: {
  root: string
  channel: UpgradeChannel
  signal?: AbortSignal
}): Promise<RemoteTarget | undefined> {
  if (channel === 'stable') {
    return await newestRelease({
      root,
      signal,
    })
  }

  const commit = (await git({
    root,
    signal,
    args: [
      'ls-remote',
      'origin',
      MAIN,
    ],
  })).split(/\s/)[0]

  return commit ? {
    ref: MAIN,
    commit,
  } : undefined
}

export async function upgradeAvailable({
  root = OTHRYS_ROOT,
  channel,
}: {
  root?: string
  channel: UpgradeChannel
}) {
  try {
    const head = await git({
      root,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    const began = cutCommit({ startFile: await startCommitFile({ root }) })

    // A cut upgrade that already pulled leaves origin with nothing newer, yet the build is still the old one.
    if (began !== undefined && began !== head) {
      return true
    }

    const remote = (await remoteTarget({
      root,
      channel,
    }))?.commit

    if (!remote) {
      return undefined
    }

    if (remote === head) {
      return false
    }

    // A remote commit this checkout already contains is not news; one it never fetched is.
    try {
      await git({
        root,
        args: [
          'merge-base',
          '--is-ancestor',
          remote,
          'HEAD',
        ],
      })

      return false
    } catch {
      return true
    }
  } catch {
    // Offline or no origin: no answer, so the page shows no hint.
    return undefined
  }
}

// A git read that fails on a folder that is not a checkout, or offline, leaves its value unknown.
async function unknownOnFailure<T>({ read }: { read(): Promise<T> }) {
  try {
    return await read()
  } catch {
    return undefined
  }
}

async function upgradeFacts({ root }: { root: string }): Promise<string[]> {
  const branch = await unknownOnFailure({
    read: () => git({
      root,
      args: [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ],
    }),
  })

  if (branch === undefined) {
    return ['The Othrys folder is not a git checkout.']
  }

  const changed = (await git({
    root,
    args: [
      'status',
      '--porcelain',
      '--untracked-files=no',
    ],
  })).split('\n').filter(Boolean)
    .map(line => basename(line.slice(3).split(' -> ')
      .at(-1)!))
  const shown = changed.slice(
    0,
    3,
  ).join(', ')

  const reasons: string[] = []

  if (branch === 'HEAD') {
    reasons.push('Detached HEAD, not on main.')
  } else if (branch !== 'main') {
    reasons.push(`On ${branch}, not main.`)
  }

  if (changed.length) {
    const more = changed.length > 3 ? ` and ${changed.length - 3} more` : ''
    reasons.push(`${changed.length} ${changed.length === 1 ? 'file' : 'files'} with local changes: ${shown}${more}.`)
  }

  return reasons
}

// The file that holds the commit an upgrade began on until it ends, so the next one can tell a cut upgrade from an up-to-date folder.
const startCommitFile = async ({ root }: { root: string }) => resolve(
  root,
  await git({
    root,
    args: [
      'rev-parse',
      '--git-path',
      'othrys-upgrade-from',
    ],
  }),
)

// The commit a cut upgrade began on; undefined when none was cut.
function upgradeStart({ startFile }: { startFile: string }): {
  from: string
  stashes: string[]
} | undefined {
  if (!existsSync(startFile)) {
    return undefined
  }

  const text = readFileSync(
    startFile,
    'utf8',
  ).trim()

  return text.startsWith('{') ? JSON.parse(text) : {
    from: text,
    stashes: [],
  }
}

const cutCommit = ({ startFile }: { startFile: string }) => upgradeStart({ startFile })?.from

export type UpgradeResult = Pick<UpgradeOperation, 'steps' | 'from' | 'to' | 'failed' | 'error' | 'reasons' | 'rolledBack'> & {
  state: 'upgraded' | 'current' | 'failed' | 'refused' | 'stopped'
}

let busy = false

// The caller restarts the server, and only after this reports upgraded.
// The busy flag guards one process: a CLI and a server upgrading at once can still race.
export async function runUpgrade({
  root = OTHRYS_ROOT,
  channel,
  progress = () => {},
  signal,
}: {
  root?: string
  channel: UpgradeChannel
  progress?({ steps }: { steps: UpgradeStep[] }): void | Promise<void>
  // Aborting stops the running step and goes back, as a failed step does.
  signal?: AbortSignal
}): Promise<UpgradeResult> {
  if (busy) {
    return {
      state: 'refused',
      steps: [],
      reasons: ['Another upgrade is already running.'],
    }
  }

  busy = true
  const started = performance.now()

  try {
    const result = await upgrade({
      root,
      channel,
      progress,
      signal,
    })
    log({
      operation: 'upgrade',
      status: result.state,
      ms: performance.now() - started,
    })

    return result
  } finally {
    busy = false
  }
}

async function upgrade({
  root,
  channel,
  progress,
  signal,
}: {
  root: string
  channel: UpgradeChannel
  progress({ steps }: { steps: UpgradeStep[] }): void | Promise<void>
  signal?: AbortSignal
}): Promise<UpgradeResult> {
  const steps: UpgradeStep[] = []
  const reasons = await upgradeFacts({ root })
  const head = await unknownOnFailure({
    read: () => git({
      root,
      args: [
        'rev-parse',
        'HEAD',
      ],
    }),
  })

  if (signal?.aborted) {
    return {
      state: 'stopped',
      steps,
      from: head,
      rolledBack: true,
    }
  }

  if (head === undefined) {
    return {
      state: 'refused',
      steps,
      reasons: ['The current commit could not be read.'],
    }
  }

  const startFile = await startCommitFile({ root })
  const previousAttempt = upgradeStart({ startFile })
  const began = previousAttempt?.from
  const savedStashes = previousAttempt?.stashes ?? []

  for (const saved of savedStashes) {
    reasons.push(`Saved local work as ${saved}. Use git stash apply ${saved} in the Othrys folder to restore it.`)
  }

  const cut = began !== undefined
  // An upgrade cut before it ended is finished from the commit it began on, or goes back to it.
  const from = cut ? began : head

  if (!cut) {
    replaceFile({
      path: startFile,
      text: JSON.stringify({
        from,
        stashes: savedStashes,
      }),
    })
  }

  const ended = ({ result }: { result: UpgradeResult }) => {
    const partlyUpgraded = result.rolledBack === false

    // A folder left partly upgraded keeps the file, so the next upgrade still knows where it began.
    if (!partlyUpgraded) {
      rmSync(
        startFile,
        { force: true },
      )
    }

    return {
      ...result,
      reasons,
    }
  }

  let to: string | undefined
  let checkoutMayHaveChanged = false

  const step = async ({
    name,
    work,
  }: {
    name: UpgradeStepName
    work(): Promise<unknown>
  }) => {
    const started = Date.now()
    const entry: UpgradeStep = {
      step: name,
      state: 'running',
      seconds: 0,
    }
    steps.push(entry)
    await progress({ steps })

    try {
      signal?.throwIfAborted()
      await work()
      // A stop that lands as the step ends still goes back.
      signal?.throwIfAborted()
      entry.state = 'done'
    } catch (error) {
      entry.state = signal?.aborted ? 'stopped' : 'failed'
      throw error
    } finally {
      entry.seconds = Math.round((Date.now() - started) / 1000)
      await progress({ steps })
    }
  }

  try {
    await step({
      name: 'pull',
      work: async () => {
        const target = channel === 'stable' ? await remoteTarget({
          root,
          channel,
          signal,
        }) : { ref: MAIN }

        if (!target) {
          throw new Error(NO_RELEASE)
        }

        signal?.throwIfAborted()
        checkoutMayHaveChanged = true
        const changes = await git({
          root,
          args: [
            'status',
            '--porcelain',
            '--untracked-files=all',
          ],
        })

        if (changes) {
          await git({
            root,
            args: [
              'stash',
              'push',
              '--include-untracked',
              '-m',
              'Othrys upgrade saved local work',
            ],
          })
          const saved = await git({
            root,
            args: [
              'rev-parse',
              'refs/stash',
            ],
          })
          savedStashes.push(saved)
          replaceFile({
            path: startFile,
            text: JSON.stringify({
              from,
              stashes: savedStashes,
            }),
          })
          reasons.push(`Saved local work as ${saved}. Use git stash apply ${saved} in the Othrys folder to restore it.`)
        }

        await git({
          root,
          args: [
            'fetch',
            'origin',
            target.ref,
          ],
          signal,
        })
        to = await git({
          root,
          args: [
            'rev-parse',
            'FETCH_HEAD^{commit}',
          ],
        })
        await git({
          root,
          args: [
            'merge',
            '--ff-only',
            to,
          ],
        })
      },
    })

    const pulled = await git({
      root,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })

    if (pulled === from) {
      return ended({
        result: {
          state: 'current',
          steps,
          from,
          to: pulled,
        },
      })
    }

    await step({
      name: 'install',
      work: () => pnpm({
        root,
        args: [
          'install',
          '--frozen-lockfile',
        ],
        signal,
      }),
    })
    await step({
      name: 'build',
      work: () => pnpm({
        root,
        args: [
          'run',
          'build',
        ],
        signal,
      }),
    })

    return ended({
      result: {
        state: 'upgraded',
        steps,
        from,
        to: pulled,
      },
    })
  } catch (error) {
    const failed = steps.at(-1)!.step
    const stopped = signal?.aborted
    let detail = stopped ? undefined : (error as Error).message
    let rolledBack = !cut

    try {
      if (checkoutMayHaveChanged) {
        await rollback({
          root,
          from,
          // The cut upgrade may have installed already, whatever step failed in this one.
          failed: cut ? 'build' : failed,
        })
        rolledBack = true
      }
    } catch (rollbackError) {
      rolledBack = false
      detail = [
        detail,
        `Going back failed too: ${(rollbackError as Error).message}`,
      ].filter(Boolean).join('\n')
    }

    return ended({
      result: {
        state: stopped ? 'stopped' : 'failed',
        steps,
        from,
        to,
        failed,
        error: detail,
        rolledBack,
      },
    })
  }
}

// Undoes what ran: the commit, then the install and build of the old commit when they had changed.
async function rollback({
  root,
  from,
  failed,
}: {
  root: string
  from: string
  failed: UpgradeStepName
}) {
  await git({
    root,
    args: [
      'reset',
      // Keeps, or refuses over, any edit made in the folder while the upgrade ran.
      '--keep',
      from,
    ],
  })

  const rebuilt = failed === 'build' || failed === 'data'

  if (failed === 'install' || rebuilt) {
    await pnpm({
      root,
      args: [
        'install',
        '--frozen-lockfile',
      ],
    })
  }

  if (rebuilt) {
    await pnpm({
      root,
      args: [
        'run',
        'build',
      ],
    })
  }
}
