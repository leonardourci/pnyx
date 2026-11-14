import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { git } from './setup/upgrade.ts'

let pnyx: Pnyx
const github = join(
  process.env.TMPDIR!,
  'github',
)

beforeAll(async () => {
  mkdirSync(
    join(
      github,
      'o',
      'shop',
    ),
    { recursive: true },
  )
  // Pull request state comes from this fake gh-axi, never GitHub.
  process.env.PNYX_FAKE_GITHUB = github
  process.env.PNYX_GH_AXI = join(
    import.meta.dirname,
    'setup',
    'fixtures',
    'gh-axi.mjs',
  )
  pnyx = await startPnyx()
})

// A git project with one commit on main, attached with this landing rule; without a remote it gets a local bare origin.
const createProject = async ({
  hydra,
  landing,
  remote,
}: {
  hydra: Hydra
  landing: 'branch' | 'pr'
  remote?: string
}) => {
  const path = hydra.folder({ name: 'shop' })
  const origin = remote ?? `${path}.git`
  const steps = [
    [
      'init',
      '-q',
      '-b',
      'main',
    ],
    [
      'add',
      '.',
    ],
    [
      'commit',
      '-q',
      '-m',
      'init',
    ],
    [
      'remote',
      'add',
      'origin',
      origin,
    ],
  ]
  writeFileSync(
    join(
      path,
      'README.md',
    ),
    'shop\n',
  )

  for (const args of steps) {
    git({
      cwd: path,
      args,
    })
  }

  if (!remote) {
    git({
      cwd: path,
      args: [
        'init',
        '-q',
        '--bare',
        '-b',
        'main',
        origin,
      ],
    })
    git({
      cwd: path,
      args: [
        'push',
        '-q',
        'origin',
        'main',
      ],
    })
  }

  await hydra.owner({
    args: [
      'project',
      'add',
      path,
      '--landing',
      landing,
    ],
  })

  return path
}

const pullRequest = ({
  number,
  state,
}: {
  number: number
  state: 'open' | 'merged'
}) => writeFileSync(
  join(
    github,
    'o',
    'shop',
    `${number}.json`,
  ),
  JSON.stringify({
    state,
    title: 'Add the cart',
  }),
)

test(
  'a project task runs in its own copy on its own branch, leaves the project folder alone, and is done only once its work is committed',
  async () => {
    const hydra = await pnyx.hydra()
    const path = await createProject({
      hydra,
      landing: 'branch',
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Add the cart',
        '--key',
        'cart',
        '--project',
        'shop',
      ],
    })
    const { task } = await hydra.owner({
      args: [
        'task',
        'show',
        'cart',
      ],
    })
    const started = await hydra.owner({
      args: [
        'task',
        'start',
        'cart',
      ],
    })
    const copy = started.agent.folder as string
    expect(copy.startsWith(join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'copies',
    ))).toBe(true)
    const worker = await hydra.agent({ cwd: copy })
    expect(git({
      cwd: copy,
      args: [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ],
    })).toBe(`pnyx/${hydra.id}-${task.id}`)

    writeFileSync(
      join(
        copy,
        'cart.txt',
      ),
      'cart\n',
    )
    expect(await hydra.as({ session: worker }).refused({
      args: [
        'task',
        'status',
        'cart',
        'done',
      ],
    })).toMatchObject({
      code: 'NOT_LANDED',
      error: 'not done yet: 1 file uncommitted',
    })

    git({
      cwd: copy,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: copy,
      args: [
        'commit',
        '-q',
        '-m',
        'Add the cart',
      ],
    })
    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'status',
        'cart',
        'done',
      ],
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'cart',
      ],
    })).task.status).toBe('done')
    expect(git({
      cwd: path,
      args: [
        'status',
        '--short',
      ],
    })).toBe('')
    expect(git({
      cwd: path,
      args: [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ],
    })).toBe('main')
    expect(git({
      cwd: path,
      args: [
        'log',
        '--format=%s',
        'main',
      ],
    })).toBe('init')
  },
)

test(
  'a pull-request task is done only once GitHub reports its pull request merged',
  async () => {
    const hydra = await pnyx.hydra()
    await createProject({
      hydra,
      landing: 'pr',
      remote: 'https://github.com/o/shop.git',
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Add the cart',
        '--key',
        'cart',
        '--project',
        'shop',
      ],
    })
    pullRequest({
      number: 7,
      state: 'open',
    })
    await hydra.owner({
      args: [
        'link',
        'cart',
        '--url',
        'https://github.com/o/shop/pull/7',
      ],
    })
    expect(await hydra.ownerRefused({
      args: [
        'task',
        'status',
        'cart',
        'done',
      ],
    })).toMatchObject({
      code: 'NOT_LANDED',
      error: 'not done yet: its pull request has not merged',
    })
    await until({
      what: 'the card to read the open pull request',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'cart',
          '--full',
        ],
      })).task.links[0]?.checkedAt,
    })

    pullRequest({
      number: 7,
      state: 'merged',
    })
    const done = await until({
      what: 'the merge to finish the task',
      check: async () => {
        const { task } = await hydra.owner({
          args: [
            'task',
            'show',
            'cart',
          ],
        })

        return task.status.startsWith('done') && task
      },
    })
    expect(done.status).toBe('done: Pull request https://github.com/o/shop/pull/7 merged')
    expect(done.column).toBe((await hydra.owner({
      args: [
        'column',
        'list',
      ],
    })).columns.find((column: { role: string }) => column.role === 'done').id)
    expect(readFileSync(
      join(
        github,
        'calls.jsonl',
      ),
      'utf8',
    )).not.toContain('PUT')
  },
)

// git as a worker runs it, which can fail: whether it passed is the result.
const attempt = ({
  cwd,
  args,
  env = {},
}: {
  cwd: string
  args: string[]
  env?: NodeJS.ProcessEnv
}) => spawnSync(
  'git',
  [
    '-C',
    cwd,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    ...args,
  ],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  },
).status === 0

const upstreamOf = ({
  cwd,
  branch,
}: {
  cwd: string
  branch: string
}) => git({
  cwd,
  args: [
    'for-each-ref',
    '--format=%(upstream)',
    `refs/heads/${branch}`,
  ],
})

test(
  'task branches never track the default branch, so a plain push from a task copy never lands on main',
  async () => {
    const hydra = await pnyx.hydra()
    const project = await createProject({
      hydra,
      landing: 'pr',
    })
    const origin = `${project}.git`
    // With this setting a plain push goes to the branch's upstream, which is how a task once pushed onto main.
    git({
      cwd: project,
      args: [
        'config',
        'push.default',
        'upstream',
      ],
    })
    writeFileSync(
      join(
        project,
        '.git',
        'info',
        'exclude',
      ),
      'pool-proof\n',
    )
    const mainOf = () => git({
      cwd: origin,
      args: [
        'rev-parse',
        'refs/heads/main',
      ],
    })
    const main = mainOf()

    const start = async ({
      key,
      harness = 'claude',
    }: {
      key: string
      harness?: 'claude' | 'codex'
    }) => {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
          '--project',
          'shop',
          '--ask',
          'Work',
        ],
      })
      const started = await hydra.owner({
        args: [
          'task',
          'start',
          key,
          '--harness',
          harness,
        ],
      })
      const path = started.agent.folder as string

      return {
        path,
        branch: git({
          cwd: path,
          args: [
            'branch',
            '--show-current',
          ],
        }),
      }
    }

    // A fresh copy has no upstream, and only the push that names the task branch publishes it.
    const first = await start({ key: 'first' })
    writeFileSync(
      join(
        first.path,
        'pool-proof',
      ),
      'keep this ignored file\n',
    )
    expect(upstreamOf({
      cwd: first.path,
      branch: first.branch,
    })).toBe('')
    writeFileSync(
      join(
        first.path,
        'work.txt',
      ),
      'synthetic work\n',
    )
    git({
      cwd: first.path,
      args: [
        'add',
        'work.txt',
      ],
    })
    git({
      cwd: first.path,
      args: [
        'commit',
        '-qm',
        'work',
      ],
    })
    expect(attempt({
      cwd: first.path,
      args: ['push'],
    })).toBe(false)
    expect(mainOf()).toBe(main)
    git({
      cwd: first.path,
      args: [
        'push',
        '-q',
        '-u',
        'origin',
        `HEAD:refs/heads/${first.branch}`,
      ],
    })
    expect(git({
      cwd: origin,
      args: [
        'rev-parse',
        `refs/heads/${first.branch}`,
      ],
    })).toBe(git({
      cwd: first.path,
      args: [
        'rev-parse',
        'HEAD',
      ],
    }))
    expect(mainOf()).toBe(main)
    expect(upstreamOf({
      cwd: first.path,
      branch: first.branch,
    })).toBe(`refs/remotes/origin/${first.branch}`)

    // A branch the worker makes itself is untracked too: Pnyx starts its agent with that git setting.
    const worker = await hydra.agent({ cwd: first.path })
    expect(worker.env.GIT_CONFIG_COUNT).toBe('1')

    for (const args of [
      [
        'switch',
        '--quiet',
        '-c',
        'fix/own',
        'origin/main',
      ],
      [
        'checkout',
        '--quiet',
        '-B',
        'fix/rebuilt',
        'origin/main',
      ],
    ]) {
      expect(attempt({
        cwd: first.path,
        args,
        env: worker.env,
      })).toBe(true)
      expect(upstreamOf({
        cwd: first.path,
        branch: args.at(-2)!,
      })).toBe('')
    }

    expect(attempt({
      cwd: first.path,
      args: ['push'],
      env: worker.env,
    })).toBe(false)
    expect(mainOf()).toBe(main)
    git({
      cwd: first.path,
      args: [
        'switch',
        '--quiet',
        first.branch,
      ],
    })

    // A Codex worker's shell gets the same setting.
    const codexed = await start({
      key: 'codexed',
      harness: 'codex',
    })
    expect((await hydra.agent({ cwd: codexed.path })).config).toMatchObject({
      'shell_environment_policy.set.GIT_CONFIG_COUNT': '1',
      'shell_environment_policy.set.GIT_CONFIG_KEY_0': 'branch.autoSetupMerge',
    })

    // Task branches made before the fix still track main: a recorded copy's and another task's are repaired on the next
    // start, while a branch that is not a task's, or a task branch tracking its own remote branch, is left alone.
    git({
      cwd: first.path,
      args: [
        'branch',
        '--set-upstream-to=origin/main',
        first.branch,
      ],
    })

    for (const branch of [
      'pnyx/other-task-1',
      'fix/feature-work',
    ]) {
      git({
        cwd: project,
        args: [
          'branch',
          '--track',
          branch,
          'origin/main',
        ],
      })
    }

    await start({ key: 'second' })
    expect(upstreamOf({
      cwd: first.path,
      branch: first.branch,
    })).toBe('')
    expect(upstreamOf({
      cwd: project,
      branch: 'pnyx/other-task-1',
    })).toBe('')
    expect(upstreamOf({
      cwd: project,
      branch: 'fix/feature-work',
    })).toBe('refs/remotes/origin/main')
    git({
      cwd: first.path,
      args: [
        'branch',
        `--set-upstream-to=origin/${first.branch}`,
        first.branch,
      ],
    })
    await start({ key: 'third' })
    expect(upstreamOf({
      cwd: first.path,
      branch: first.branch,
    })).toBe(`refs/remotes/origin/${first.branch}`)

    // What push reads is branch.<name>.merge, even where the fetch refspec maps no tracking branch for it.
    git({
      cwd: project,
      args: [
        'branch',
        'pnyx/custom-refspec-1',
        'origin/main',
      ],
    })
    git({
      cwd: project,
      args: [
        'config',
        'branch.pnyx/custom-refspec-1.remote',
        'origin',
      ],
    })
    git({
      cwd: project,
      args: [
        'config',
        'branch.pnyx/custom-refspec-1.merge',
        'refs/heads/main',
      ],
    })
    git({
      cwd: project,
      args: [
        'config',
        'remote.origin.fetch',
        '+refs/heads/pnyx/*:refs/remotes/origin/pnyx/*',
      ],
    })
    expect(upstreamOf({
      cwd: project,
      branch: 'pnyx/custom-refspec-1',
    })).toBe('')
    await start({ key: 'fourth' })
    expect(attempt({
      cwd: project,
      args: [
        'config',
        'branch.pnyx/custom-refspec-1.merge',
      ],
    })).toBe(false)
    git({
      cwd: project,
      args: [
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ],
    })

    // A task whose branch exists but whose copy is gone starts again on that branch, without an upstream.
    const gone = await start({ key: 'gone' })
    await hydra.owner({
      args: [
        'task',
        'detach',
        'gone',
      ],
    })
    git({
      cwd: project,
      args: [
        'branch',
        '--set-upstream-to=origin/main',
        gone.branch,
      ],
    })
    rmSync(
      gone.path,
      {
        recursive: true,
        force: true,
      },
    )
    const again = await hydra.owner({
      args: [
        'task',
        'start',
        'gone',
      ],
    })
    expect(existsSync(again.agent.folder)).toBe(true)
    expect(git({
      cwd: again.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe(gone.branch)
    expect(upstreamOf({
      cwd: project,
      branch: gone.branch,
    })).toBe('')

    // Once the first task's work is on main, its removed copy's folder is reused by the next task, keeping its ignored
    // files and without an upstream.
    git({
      cwd: first.path,
      args: [
        'push',
        '-q',
        'origin',
        'HEAD:refs/heads/main',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'copy',
        'first',
        'remove',
        '--safe',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'detach',
        'first',
      ],
    })
    const pooled = await start({ key: 'pooled' })
    expect(pooled.path).toBe(first.path)
    expect(existsSync(join(
      pooled.path,
      'pool-proof',
    ))).toBe(true)
    expect(upstreamOf({
      cwd: pooled.path,
      branch: pooled.branch,
    })).toBe('')
  },
)
