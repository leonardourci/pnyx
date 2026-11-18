import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { git } from './setup/upgrade.ts'
import { createTaskBranch, taskBranch } from '#projects/git.ts'

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
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Hércules',
      ],
    })
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
    })).toBe('hercules/add-cart')

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
      error: expect.stringContaining('uncommitted'),
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
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Next chart',
        '--key',
        'next',
        '--project',
        'shop',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'brief',
        'next',
        '--brief',
        'Draw the next chart',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'queue',
        'next',
        '--behind',
        'cart',
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
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Handoff gate',
        '--key',
        'gate',
      ],
    })
    const hooks = join(
      path,
      'test-hooks',
    )
    const hookMarker = join(
      path,
      'handoff-declined',
    )
    mkdirSync(hooks)
    const hook = `#!${process.execPath}
const { execFileSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
if (branch === 'hercules/next-chart-2') {
  execFileSync(process.execPath, ${JSON.stringify([
    join(
      import.meta.dirname,
      '..',
      'dist',
      'cli',
      'pnyx-axi.js',
    ),
    'task',
    'depend',
    'next',
    '--on',
    'gate',
    '--hydra',
  ])}.concat(${JSON.stringify(hydra.id)}))
  writeFileSync(${JSON.stringify(hookMarker)}, 'declined')
}
`
    writeFileSync(
      join(
        hooks,
        'post-checkout',
      ),
      hook,
      { mode: 0o700 },
    )
    await pnyx.restart({
      whileStopped: async () => {
        git({
          cwd: path,
          args: [
            'merge',
            '--ff-only',
            'hercules/add-cart',
          ],
        })
        git({
          cwd: path,
          args: [
            'push',
            'origin',
            'main',
          ],
        })
        git({
          cwd: path,
          args: [
            'branch',
            'hercules/next-chart',
          ],
        })
        git({
          cwd: path,
          args: [
            'config',
            'core.hooksPath',
            hooks,
          ],
        })
        expect(git({
          cwd: copy,
          args: [
            'branch',
            '--show-current',
          ],
        })).toBe('hercules/add-cart')
      },
    })
    await until({
      what: 'handoff declined during Git checkout',
      check: () => existsSync(hookMarker),
    })
    await until({
      what: 'original checkout restored after declined handoff',
      check: () =>
        git({
          cwd: copy,
          args: [
            'branch',
            '--show-current',
          ],
        }) === 'hercules/add-cart',
    })
    const declined = await hydra.owner({
      args: [
        'task',
        'show',
        'next',
        '--full',
      ],
    })
    expect(declined.task.sessionIds ?? []).toEqual([])
    expect(git({
      cwd: path,
      args: [
        'branch',
        '--list',
        'hercules/next-chart-2',
      ],
    })).toContain('hercules/next-chart-2')
    git({
      cwd: path,
      args: [
        'config',
        '--unset',
        'core.hooksPath',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'undepend',
        'next',
        '--on',
        'gate',
      ],
    })
    await pnyx.restart({
      whileStopped: () => {
        expect(git({
          cwd: copy,
          args: [
            'branch',
            '--show-current',
          ],
        })).toBe('hercules/add-cart')
        expect(git({
          cwd: path,
          args: [
            'branch',
            '--list',
            'hercules/next-chart-2',
          ],
        })).toContain('hercules/next-chart-2')
      },
    })
    await until({
      what: 'queued task handoff on its readable branch',
      check: async () => {
        const { copy } = await hydra.owner({
          args: [
            'task',
            'copy',
            'next',
          ],
        })

        return copy?.branch === 'hercules/next-chart-3'
      },
    })
    expect(git({
      cwd: copy,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('hercules/next-chart-3')
    await until({
      what: 'readable branch in delivered brief',
      check: async () => (await hydra.agent({ cwd: copy })).received.some(text => text.includes('on fresh branch hercules/next-chart-3')),
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Failure hook',
        '--key',
        'failure',
        '--project',
        'shop',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'brief',
        'failure',
        '--brief',
        'Check the hook failure',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'queue',
        'failure',
        '--behind',
        'next',
      ],
    })
    const failureMarker = join(
      path,
      'checkout-failed',
    )
    writeFileSync(
      join(
        hooks,
        'post-checkout',
      ),
      `#!${process.execPath}
const { execFileSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
if (execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() === 'hercules/failure-hook') {
  writeFileSync(${JSON.stringify(failureMarker)}, 'failed')
  throw new Error('fixture checkout failure')
}
`,
    )
    git({
      cwd: path,
      args: [
        'config',
        'core.hooksPath',
        hooks,
      ],
    })
    const nextWorker = await hydra.agent({ cwd: copy })
    await hydra.as({ session: nextWorker }).run({
      args: [
        'task',
        'status',
        'next',
        'done',
      ],
    })
    await pnyx.restart()
    await until({
      what: 'checkout hook failure',
      check: () => existsSync(failureMarker),
    })
    await until({
      what: 'checkout restored after the hook failed',
      check: () =>
        git({
          cwd: copy,
          args: [
            'branch',
            '--show-current',
          ],
        }) === 'hercules/next-chart-3',
    })
    await until({
      what: 'hook failure reported on the released task',
      check: async () => {
        const { task } = await hydra.owner({
          args: [
            'task',
            'show',
            'failure',
            '--full',
          ],
        })

        return task.queueNote?.includes('fixture checkout failure')
      },
    })
    expect(git({
      cwd: path,
      args: [
        'branch',
        '--list',
        'hercules/failure-hook',
      ],
    })).toContain('hercules/failure-hook')
    git({
      cwd: path,
      args: [
        'config',
        '--unset',
        'core.hooksPath',
      ],
    })
  },
)

test(
  'a pull-request task is done only once GitHub reports its pull request merged, and one with an unreviewed report waits for its review',
  async () => {
    const hydra = await pnyx.hydra()
    await createProject({
      hydra,
      landing: 'pr',
      remote: 'https://github.com/o/shop.git',
    })
    // Merges wake only a Hydra that Pnyx runs.
    const main = await hydra.chat({ text: 'Watch the shop' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Write the cart notes',
        '--key',
        'notes',
        '--project',
        'shop',
      ],
    })
    const reportFile = join(
      hydra.folder({ name: 'notes' }),
      'report.md',
    )
    writeFileSync(
      reportFile,
      'The cart keeps its items for a week.\n',
    )
    await hydra.owner({
      args: [
        'task',
        'report',
        'notes',
        '--file',
        reportFile,
      ],
    })
    pullRequest({
      number: 8,
      state: 'open',
    })
    await hydra.owner({
      args: [
        'link',
        'notes',
        '--url',
        'https://github.com/o/shop/pull/8',
      ],
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
      error: expect.stringContaining('pull request'),
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
      number: 8,
      state: 'merged',
    })
    await until({
      what: 'the notes pull request to be recorded merged',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'notes',
          '--full',
        ],
      })).task.links[0]?.state === 'merged',
    })
    await until({
      what: 'Hydra to hear the merge waits for the report review',
      check: () => main.received.some(text => text.split('\n').some(line => line.includes('https://github.com/o/shop/pull/8')
        && line.includes('task report-review'))),
    })

    // The cart pull request below must still be followed once this merge is recorded.
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
    expect(done.status).toMatch(/^done:/)
    expect(done.status).toContain('https://github.com/o/shop/pull/7')
    expect(done.column).toBe(await hydra.column({ role: 'done' }))
    expect(merges({ number: 7 })).toBe(0)

    // A full follow pass has run since the notes merge, and its report still waits for review.
    const { task: notes } = await hydra.owner({
      args: [
        'task',
        'show',
        'notes',
      ],
    })
    expect(notes.status).not.toMatch(/^done/)
    expect(notes.column).not.toBe(await hydra.column({ role: 'done' }))

    const { id: report } = await hydra.owner({
      args: [
        'task',
        'report',
        'notes',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'report-review',
        'notes',
        '--report',
        report,
        '--none',
      ],
    })
    const reviewed = await until({
      what: 'the reviewed report to let the merge finish its task',
      check: async () => {
        const { task } = await hydra.owner({
          args: [
            'task',
            'show',
            'notes',
          ],
        })

        return task.status.startsWith('done') && task
      },
    })
    expect(reviewed.status).toContain('https://github.com/o/shop/pull/8')
    expect(reviewed.column).toBe(await hydra.column({ role: 'done' }))
  },
)

// The merge requests the fake GitHub received for a pull request.
const merges = ({ number }: { number: number }) => readFileSync(
  join(
    github,
    'calls.jsonl',
  ),
  'utf8',
).split('\n')
  .filter(line => line.includes('PUT') && line.includes(`/pulls/${number}/merge`)).length

test(
  'Hydra merges a pull request only on the owner\'s Merge answer with green checks, a Hold blocks it, and a merge is submitted once, even after a restart',
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
        'gate',
        '--project',
        'shop',
      ],
    })
    const url = 'https://github.com/o/shop/pull/21'
    const publish = ({
      checks,
      mergeBehavior,
    }: {
      checks: string
      mergeBehavior?: string
    }) => writeFileSync(
      join(
        github,
        'o',
        'shop',
        '21.json',
      ),
      JSON.stringify({
        state: 'open',
        title: 'Add the cart',
        head: 'c'.repeat(40),
        checks,
        mergeBehavior,
      }),
    )
    publish({ checks: '0 passed, 1 failed, 1 total' })
    await hydra.owner({
      args: [
        'link',
        'gate',
        '--url',
        url,
      ],
    })
    const ask = await until({
      what: 'the merge question',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'gate',
          '--full',
        ],
      })).task.asks?.find((candidate: { kind: string }) => candidate.kind === 'merge'),
    })
    const session = await hydra.chat({ text: 'Review the open pull requests.' })
    const asHydra = hydra.as({ session })
    const merge = [
      'task',
      'merge',
      'gate',
      '--url',
      url,
    ]

    await hydra.owner({
      args: [
        'task',
        'answer',
        'gate',
        ask.id,
        '--choice',
        'Hold',
      ],
    })
    expect((await asHydra.refused({ args: merge })).code).toBe('FORBIDDEN')

    const go = await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Merge PR #21 now.',
      ],
    })
    await asHydra.run({
      args: [
        'task',
        'answer',
        'gate',
        ask.id,
        '--from-message',
        go.message,
        '--choice',
        'Merge',
        '--reason',
        'The owner now says to merge this pull request',
      ],
    })
    // Approved, but the checks are red: nothing is submitted.
    expect((await asHydra.refused({ args: merge })).code).toBe('CONFLICT')
    expect(merges({ number: 21 })).toBe(0)

    publish({
      checks: '1 passed, 0 failed, 1 total',
      mergeBehavior: 'queued',
    })
    await asHydra.run({ args: merge })
    expect(merges({ number: 21 })).toBe(1)

    await pnyx.restart()
    await asHydra.run({ args: merge })
    expect(merges({ number: 21 })).toBe(1)
  },
)

test.each([
  {
    repo: 'private-forbidden',
    rulesError: 'error: "Insufficient permissions for this action"\ncode: FORBIDDEN',
  },
  {
    repo: 'private-missing',
    rulesError: 'error: HTTP 404: Not Found',
  },
  {
    repo: 'private-http-forbidden',
    rulesError: 'error: HTTP 403: Forbidden',
  },
  {
    repo: 'private-structured-missing',
    rulesError: 'error: "Resource not found"\ncode: NOT_FOUND',
  },
])(
  'Hydra merges $repo with unreadable branch rules while enforcing approval and readable checks',
  async ({
    repo,
    rulesError,
  }) => {
    const hydra = await pnyx.hydra()
    const folder = join(
      github,
      'o',
      repo,
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    await createProject({
      hydra,
      landing: 'pr',
      remote: `https://github.com/o/${repo}.git`,
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Fix private merge',
        '--key',
        'private',
        '--project',
        'shop',
      ],
    })
    const head = 'd'.repeat(40)
    const url = `https://github.com/o/${repo}/pull/22`
    writeFileSync(
      join(
        folder,
        '22.json',
      ),
      JSON.stringify({
        state: 'open',
        head,
        checks: '1 passed, 0 failed, 1 total',
      }),
    )
    const evidenceFile = join(
      folder,
      'evidence.json',
    )
    const classicRule = {
      requiresStatusChecks: true,
      requiredStatusChecks: [
        {
          context: 'ci',
          app: { databaseId: 42 },
        },
      ],
    }
    const run = {
      name: 'ci',
      head_sha: head,
      app: { id: 42 },
      status: 'completed',
      conclusion: 'success',
    }
    const publish = ({
      error = rulesError,
      check = run,
      classic = classicRule,
      rules = [],
    }: {
      error?: string
      check?: typeof run
      classic?: unknown
      rules?: unknown
    } = {}) => writeFileSync(
      evidenceFile,
      JSON.stringify({
        rulesError: error,
        classicRule: classic,
        checkRuns: [check],
        rules,
      }),
    )
    publish()
    await hydra.owner({
      args: [
        'link',
        'private',
        '--url',
        url,
      ],
    })
    const ask = await until({
      what: 'private repository merge question',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'private',
          '--full',
        ],
      })).task.asks?.find((candidate: { kind: string }) => candidate.kind === 'merge'),
    })
    const session = await hydra.chat({ text: 'Review the private repository pull request.' })
    const asHydra = hydra.as({ session })
    const merge = [
      'task',
      'merge',
      'private',
      '--url',
      url,
    ]
    expect((await asHydra.refused({ args: merge })).code).toBe('FORBIDDEN')
    await hydra.owner({
      args: [
        'task',
        'answer',
        'private',
        ask.id,
        '--choice',
        'Merge',
      ],
    })

    publish({
      classic: null,
      check: {
        ...run,
        conclusion: 'failure',
      },
    })
    const failed = await asHydra.refused({ args: merge })
    expect(failed.code).toBe('CONFLICT')
    expect(failed.error).toContain('check is not green')
    publish({
      check: {
        ...run,
        status: 'in_progress',
        conclusion: '',
      },
    })
    expect(await asHydra.refused({ args: merge })).toMatchObject({
      code: 'CONFLICT',
      error: expect.stringContaining('check still running'),
    })
    publish({
      check: {
        ...run,
        app: { id: 43 },
      },
    })
    expect(await asHydra.refused({ args: merge })).toMatchObject({
      code: 'CONFLICT',
      error: expect.stringContaining('missing required check'),
    })
    publish({ error: 'error: HTTP 500: server error' })
    expect(await asHydra.refused({ args: merge })).toMatchObject({
      code: 'CONFLICT',
      error: expect.stringContaining('branch rules unreadable'),
    })
    publish({
      error: '',
      rules: {},
    })
    expect(await asHydra.refused({ args: merge })).toMatchObject({
      code: 'CONFLICT',
      error: expect.stringContaining('branch rules unreadable'),
    })

    publish({ classic: {} })
    expect(await asHydra.refused({ args: merge })).toMatchObject({
      code: 'CONFLICT',
      error: expect.stringContaining('classic protection unreadable'),
    })
    publish({ classic: null })
    const result = await asHydra.run({ args: merge })
    expect(result.merge).toBe('merged')
    expect(result.head).toBe(head)
    const calls = readFileSync(
      join(
        github,
        'calls.jsonl',
      ),
      'utf8',
    ).trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    const submissions = calls.filter(args => args.includes('PUT') && args.includes(`/repos/o/${repo}/pulls/22/merge`))
    expect(submissions).toHaveLength(1)
    expect(submissions[0]).toContain(`sha=${head}`)
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
    await hydra.owner({
      args: [
        'task',
        'rename',
        'gone',
        '--title',
        'Renamed after allocation',
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
    writeFileSync(
      join(
        gone.path,
        'uncommitted.txt',
      ),
      'scratch work',
    )
    const flagged = await hydra.owner({
      args: [
        'task',
        'copy',
        'gone',
        'remove',
      ],
    })
    expect(flagged.copy.state).toBe('flagged')
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

test(
  'readable branch names strip accents and punctuation, shorten at words, and avoid local and remote collisions',
  async () => {
    const hydra = await pnyx.hydra()
    const cwd = await createProject({
      hydra,
      landing: 'branch',
    })
    const name = ({
      title,
      reserved,
    }: {
      title: string
      reserved?: string[]
    }) => taskBranch({
      cwd,
      hydraName: 'Poséidon!',
      task: 'task-abcdef12-3456',
      title,
      reserved,
    })
    expect(await name({ title: 'Clientes atendídos / vendas: chart!' })).toBe('poseidon/clientes-atendidos-vendas-chart')
    expect(await name({ title: 'The chart of the vendas and clientes atendidos across projects' })).toBe('poseidon/chart-vendas-clientes-atendidos-across')
    expect(await name({ title: '' })).toBe('poseidon/abcdef12')
    expect(await name({ title: '!!!' })).toBe('poseidon/abcdef12')
    git({
      cwd,
      args: [
        'branch',
        'poseidon/chart',
      ],
    })
    git({
      cwd,
      args: [
        'push',
        'origin',
        'HEAD:refs/heads/poseidon/chart-2',
      ],
    })
    expect(await name({ title: 'Chart' })).toBe('poseidon/chart-3')
    expect(await name({
      title: 'Chart',
      reserved: ['poseidon/chart-3'],
    })).toBe('poseidon/chart-4')
    let active = true
    expect(await createTaskBranch({
      cwd,
      hydraName: 'Iris',
      task: 'task-cancelled',
      title: 'Cancelled',
      start: 'HEAD',
      active: () => active,
      prepare: async () => {
        active = false

        return true
      },
    })).toBeUndefined()
    expect(git({
      cwd,
      args: [
        'branch',
        '--list',
        'iris/cancelled',
      ],
    })).toBe('')
    const simultaneous = await Promise.all([
      createTaskBranch({
        cwd,
        hydraName: 'Iris',
        task: 'task-one',
        title: 'Chart',
        start: 'HEAD',
      }),
      createTaskBranch({
        cwd,
        hydraName: 'Iris',
        task: 'task-two',
        title: 'Chart',
        start: 'HEAD',
      }),
    ])
    expect(simultaneous.sort()).toEqual([
      'iris/chart',
      'iris/chart-2',
    ])
    git({
      cwd,
      args: [
        'branch',
        '-d',
        'poseidon/chart',
      ],
    })
    git({
      cwd,
      args: [
        'branch',
        'poseidon',
      ],
    })
    git({
      cwd,
      args: [
        'push',
        'origin',
        'HEAD:refs/heads/poseidon-2/chart/details',
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Poséidon',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Chart',
        '--key',
        'chart',
        '--project',
        'shop',
      ],
    })
    const started = await hydra.owner({
      args: [
        'task',
        'start',
        'chart',
      ],
    })
    expect(git({
      cwd: started.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/chart-2')
    git({
      cwd,
      args: [
        'branch',
        '--set-upstream-to=origin/main',
        'poseidon-2/chart-2',
      ],
    })
    const failingHooks = join(
      cwd,
      'failing-hooks',
    )
    mkdirSync(failingHooks)
    writeFileSync(
      join(
        failingHooks,
        'post-checkout',
      ),
      '#!/bin/sh\nexit 1\n',
      { mode: 0o700 },
    )
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Retry allocation',
        '--key',
        'retry',
        '--project',
        'shop',
      ],
    })
    git({
      cwd,
      args: [
        'config',
        'core.hooksPath',
        failingHooks,
      ],
    })
    expect(await hydra.ownerRefused({
      args: [
        'task',
        'start',
        'retry',
      ],
    })).toMatchObject({ code: 'COPY_FAILED' })
    expect(git({
      cwd,
      args: [
        'branch',
        '--format=%(upstream:short)',
        '--list',
        'poseidon-2/chart-2',
      ],
    })).toBe('')
    const reserved = git({
      cwd,
      args: [
        'rev-parse',
        'refs/heads/poseidon-2/retry-allocation',
      ],
    })
    git({
      cwd,
      args: [
        'config',
        '--unset',
        'core.hooksPath',
      ],
    })
    const retried = await hydra.owner({
      args: [
        'task',
        'start',
        'retry',
      ],
    })
    expect(git({
      cwd: retried.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/retry-allocation-2')
    expect(git({
      cwd,
      args: [
        'rev-parse',
        'refs/heads/poseidon-2/retry-allocation',
      ],
    })).toBe(reserved)
    const other = await pnyx.hydra()
    await other.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Póseídon',
      ],
    })
    const attachment = await other.owner({
      args: [
        'project',
        'add',
        cwd,
        '--landing',
        'branch',
      ],
    })
    expect(attachment.confirmation).toBe('needed')
    await other.owner({
      args: [
        'project',
        'add',
        cwd,
        '--landing',
        'branch',
        '--confirm',
        attachment.token,
      ],
    })
    await other.owner({
      args: [
        'task',
        'create',
        '--title',
        'Shared name',
        '--key',
        'shared',
        '--project',
        'shop',
      ],
    })
    const otherStarted = await other.owner({
      args: [
        'task',
        'start',
        'shared',
      ],
    })
    expect(git({
      cwd: otherStarted.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/shared-name')
    git({
      cwd: otherStarted.agent.folder,
      args: [
        'switch',
        '--detach',
        'HEAD',
      ],
    })
    git({
      cwd,
      args: [
        'branch',
        '-D',
        'poseidon-2/shared-name',
      ],
    })
    expect(git({
      cwd,
      args: [
        'branch',
        '--list',
        'poseidon-2/shared-name',
      ],
    })).toBe('')
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Shared name',
        '--key',
        'shared',
        '--project',
        'shop',
      ],
    })
    const shared = await hydra.owner({
      args: [
        'task',
        'start',
        'shared',
      ],
    })
    expect(git({
      cwd: shared.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/shared-name-2')
  },
)
