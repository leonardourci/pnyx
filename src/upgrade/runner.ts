import { execFile } from 'node:child_process'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { UpgradeOperation, UpgradeStep, UpgradeStepName } from './model.ts'

// The checkout this pnyx-axi runs from: src/upgrade and dist/upgrade both sit two folders down.
export const PNYX_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
)

const exec = promisify(execFile)
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
}: {
  root: string
  command: string
  args: string[]
  timeout?: number
  env?: Record<string, string>
}): Promise<string> {
  try {
    const { stdout } = await exec(
      command,
      args,
      {
        cwd: root,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        // A remote that wants a login fails instead of waiting on a prompt nobody sees.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          ...env,
        },
      },
    )

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
}: {
  root: string
  args: string[]
}) => run({
  root,
  command: 'git',
  args,
})

// pnpm stops to ask before replacing node_modules unless it knows no one can answer.
const pnpm = ({
  root,
  args,
}: {
  root: string
  args: string[]
}) => run({
  root,
  command: 'pnpm',
  args,
  timeout: BUILD_MS,
  env: { CI: 'true' },
})

const remoteMain = async ({ root }: { root: string }) => (await git({
  root,
  args: [
    'ls-remote',
    'origin',
    'refs/heads/main',
  ],
})).split(/\s/)[0] || undefined

// Whether origin's main has a commit this checkout lacks; undefined when origin cannot be read.
export async function upgradeAvailable({ root = PNYX_ROOT }: { root?: string } = {}) {
  try {
    const remote = await remoteMain({ root })

    if (!remote) {
      return undefined
    }

    const head = await git({
      root,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })

    if (remote === head) {
      return false
    }

    // A remote commit this checkout already contains is not news; one it never fetched is.
    return await git({
      root,
      args: [
        'merge-base',
        '--is-ancestor',
        remote,
        'HEAD',
      ],
    }).then(
      () => false,
      () => true,
    )
  } catch {
    return undefined
  }
}

// Every reason the folder cannot be upgraded as it is; Pnyx never stashes or switches for the owner.
export async function refusals({ root }: { root: string }): Promise<string[]> {
  const branch = await git({
    root,
    args: [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ],
  }).catch(() => undefined)

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

  return [
    ...branch === 'main' ? [] : [branch === 'HEAD' ? 'Not on a branch, not main.' : `On ${branch}, not main.`],
    ...changed.length ? [`${changed.length} ${changed.length === 1 ? 'file' : 'files'} with local changes: ${shown}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}`] : [],
  ]
}

export type UpgradeResult = Pick<UpgradeOperation, 'steps' | 'from' | 'to' | 'failed' | 'error' | 'reasons'> & {
  state: 'upgraded' | 'current' | 'failed' | 'refused'
}

let busy = false

// Pulls main, installs and builds; a failed step puts the folder back on the commit it started from.
// The caller restarts the server, and only after this reports upgraded.
// ponytail: the busy flag guards one process; a CLI and a server upgrading at once can still race.
export async function runUpgrade({
  root = PNYX_ROOT,
  progress = () => {},
}: {
  root?: string
  progress?({ steps }: { steps: UpgradeStep[] }): void
} = {}): Promise<UpgradeResult> {
  if (busy) {
    return {
      state: 'refused',
      steps: [],
      reasons: ['Another upgrade is already running.'],
    }
  }

  busy = true

  try {
    return await upgrade({
      root,
      progress,
    })
  } finally {
    busy = false
  }
}

async function upgrade({
  root,
  progress,
}: {
  root: string
  progress({ steps }: { steps: UpgradeStep[] }): void
}): Promise<UpgradeResult> {
  const steps: UpgradeStep[] = []
  const reasons = await refusals({ root })
  const from = await git({
    root,
    args: [
      'rev-parse',
      'HEAD',
    ],
  }).catch(() => undefined)

  if (reasons.length) {
    return {
      state: 'refused',
      steps,
      reasons,
      from,
      to: await remoteMain({ root }).catch(() => undefined),
    }
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
      await work()
      entry.state = 'done'
    } catch (error) {
      entry.state = 'failed'
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

    const head = await git({
      root,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })

    if (head === from) {
      return {
        state: 'current',
        steps,
        from,
        to,
      }
    }

    await step({
      name: 'install',
      work: () => pnpm({
        root,
        args: [
          'install',
          '--frozen-lockfile',
        ],
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
      }),
    })

    return {
      state: 'upgraded',
      steps,
      from,
      to,
    }
  } catch (error) {
    const failed = steps.at(-1)!.step
    let detail = (error as Error).message

    try {
      await rollback({
        root,
        from: from!,
        failed,
      })
    } catch (rollbackError) {
      detail += `\nGoing back to ${from!.slice(
        0,
        7,
      )} failed too: ${(rollbackError as Error).message}`
    }

    return {
      state: 'failed',
      steps,
      from,
      to,
      failed,
      error: detail,
    }
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
      '--hard',
      from,
    ],
  })

  if (failed === 'install' || failed === 'build') {
    await pnpm({
      root,
      args: [
        'install',
        '--frozen-lockfile',
      ],
    })
  }

  if (failed === 'build') {
    await pnpm({
      root,
      args: [
        'run',
        'build',
      ],
    })
  }
}
