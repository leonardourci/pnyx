import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { log } from '#app/diagnostics.ts'
import { runFile } from '#app/run-process.ts'
import { replaceFile } from '#store/storage.ts'
import type { UpgradeOperation, UpgradeStep, UpgradeStepName } from './model.ts'

// The checkout this pnyx-axi runs from: src/upgrade and dist/upgrade both sit two folders down.
export const PNYX_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
)

const NETWORK_MS = 60_000
const BUILD_MS = 15 * 60_000

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

const remoteMain = async ({ root }: { root: string }) => (await git({
  root,
  args: [
    'ls-remote',
    'origin',
    'refs/heads/main',
  ],
})).split(/\s/)[0] || undefined

// Whether there is something to upgrade: a newer origin main, or a cut upgrade that already pulled; undefined when origin cannot be read.
export async function upgradeAvailable({ root = PNYX_ROOT }: { root?: string } = {}) {
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

    const remote = await remoteMain({ root })

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

// Every reason the folder cannot be upgraded as it is; Pnyx never stashes or switches for the owner.
export async function refusals({ root }: { root: string }): Promise<string[]> {
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
    return ['The Pnyx folder is not a git checkout.']
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
      'pnyx-upgrade-from',
    ],
  }),
)

// The commit a cut upgrade began on; undefined when none was cut.
const cutCommit = ({ startFile }: { startFile: string }) => existsSync(startFile) ? readFileSync(
  startFile,
  'utf8',
).trim() : undefined

export type UpgradeResult = Pick<UpgradeOperation, 'steps' | 'from' | 'to' | 'failed' | 'error' | 'reasons' | 'rolledBack'> & {
  state: 'upgraded' | 'current' | 'failed' | 'refused' | 'stopped'
}

let busy = false

// Pulls main, installs and builds; a failed or stopped step puts the folder back on the commit it started from.
// The caller restarts the server, and only after this reports upgraded.
// The busy flag guards one process: a CLI and a server upgrading at once can still race.
export async function runUpgrade({
  root = PNYX_ROOT,
  progress = () => {},
  signal,
}: {
  root?: string
  progress?({ steps }: { steps: UpgradeStep[] }): void
  // Aborting stops the running step and goes back, as a failed step does.
  signal?: AbortSignal
} = {}): Promise<UpgradeResult> {
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
  progress,
  signal,
}: {
  root: string
  progress({ steps }: { steps: UpgradeStep[] }): void
  signal?: AbortSignal
}): Promise<UpgradeResult> {
  const steps: UpgradeStep[] = []
  const reasons = await refusals({ root })
  const head = await unknownOnFailure({
    read: () => git({
      root,
      args: [
        'rev-parse',
        'HEAD',
      ],
    }),
  })

  if (reasons.length) {
    return {
      state: 'refused',
      steps,
      reasons,
      from: head,
      to: await unknownOnFailure({ read: () => remoteMain({ root }) }),
    }
  }

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
  const began = cutCommit({ startFile })
  const cut = began !== undefined
  // An upgrade cut before it ended is finished from the commit it began on, or goes back to it.
  const from = cut ? began : head

  if (!cut) {
    replaceFile({
      path: startFile,
      text: `${from}\n`,
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

    return result
  }

  let to: string | undefined

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
    progress({ steps })

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
      progress({ steps })
    }
  }

  try {
    await step({
      name: 'pull',
      work: async () => {
        await git({
          root,
          args: [
            'fetch',
            'origin',
            'main',
          ],
          signal,
        })
        to = await git({
          root,
          args: [
            'rev-parse',
            'FETCH_HEAD',
          ],
        })
        await git({
          root,
          args: [
            'merge',
            '--ff-only',
            'FETCH_HEAD',
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
          to,
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
    // The new build checks Postgres and imports every Hydra still kept in events.jsonl in a transaction it rolls back;
    // if that fails, the folder goes back and the running server keeps its files.
    await step({
      name: 'data',
      work: () => run({
        root,
        command: process.execPath,
        args: [
          'dist/cli/pnyx-axi.js',
          'setup',
          'postgres',
          '--check',
        ],
        timeout: BUILD_MS,
        signal,
      }),
    })

    return ended({
      result: {
        state: 'upgraded',
        steps,
        from,
        to,
      },
    })
  } catch (error) {
    const failed = steps.at(-1)!.step
    const stopped = signal?.aborted
    let detail = stopped ? undefined : (error as Error).message
    let rolledBack = true

    try {
      await rollback({
        root,
        from,
        // The cut upgrade may have installed already, whatever step failed in this one.
        failed: cut ? 'build' : failed,
      })
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
