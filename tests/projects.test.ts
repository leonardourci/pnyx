import { readEvents } from '#app/event-log.ts'
import workerThreads from 'node:worker_threads'
import { syncBuiltinESMExports } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { CLI, parsed, pnyxAxi, rows, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { git } from './setup/upgrade.ts'
import { legacyDuplicate } from './setup/legacy.ts'
import { createTaskBranch } from '#projects/git.ts'

const RESTART_FLOW_TIMEOUT_MS = 120_000

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
  name = 'shop',
}: {
  hydra: Hydra
  landing: 'branch' | 'pr'
  remote?: string
  name?: string
}) => {
  const path = hydra.folder({ name })
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
  'a project task runs in its own copy on its own readable branch, leaves the project folder alone, is done only once its work is committed, and hands its worker to the queued task across declined, lost and failed checkouts',
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
    CLI,
    'task',
    'brief',
    'next',
    '--brief',
    'Updated chart brief',
    '--hydra',
    hydra.id,
  ])})
  writeFileSync(${JSON.stringify(hookMarker)}, 'declined')
}
if (branch === 'hercules/add-cart') {
  execFileSync(process.execPath, ${JSON.stringify([
    CLI,
    'task',
    'depend',
    'next',
    '--on',
    'gate',
    '--hydra',
    hydra.id,
  ])})
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
    await until({
      what: 'restoration hook blocks the queued task',
      check: async () => (await hydra.task({ key: 'next' })).readiness.ready === false,
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
    const receive = workerThreads.receiveMessageOnPort
    let lostReply = false

    // eslint-disable-next-line pnyx/object-params -- Node owns this transport signature.
    workerThreads.receiveMessageOnPort = port => {
      const reply = receive(port)

      if (!lostReply && reply && !reply.message.error && reply.message.results?.length > 1 && git({
        cwd: copy,
        args: [
          'branch',
          '--show-current',
        ],
      }) === 'hercules/next-chart-3') {
        lostReply = true

        // Lose the database worker's successful commit reply at the transport boundary.
        return undefined
      }

      return reply
    }

    syncBuiltinESMExports()

    try {
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
      expect(lostReply).toBe(true)
    } finally {
      workerThreads.receiveMessageOnPort = receive
      syncBuiltinESMExports()
    }

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
    const verboseHookOutput = 'verbose hook trace '.repeat(1000)
    writeFileSync(
      join(
        hooks,
        'post-checkout',
      ),
      `#!${process.execPath}
const { execFileSync } = require('node:child_process')
const { writeFileSync, existsSync } = require('node:fs')
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
if (branch === 'hercules/failure-hook') {
  writeFileSync(${JSON.stringify(failureMarker)}, 'failed')
  process.stderr.write(${JSON.stringify(verboseHookOutput)})
  throw new Error('fixture checkout failure')
}
if (branch === 'hercules/next-chart-3' && existsSync(${JSON.stringify(failureMarker)})) {
  writeFileSync('rollback-hook-output.txt', 'checkout changed during rollback')
}
`,
      { mode: 0o700 },
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

        return task.queueNote
      },
    })
    const failedHandoff = await hydra.owner({
      args: [
        'task',
        'show',
        'failure',
        '--full',
      ],
    })
    expect(failedHandoff.task.queueNote.length).toBeLessThan(verboseHookOutput.length)
    expect(failedHandoff.task.queueNote).toContain('fixture checkout failure')
    expect(failedHandoff.task.queueNote).toContain('the previous checkout could not be restored')
    expect((await hydra.ownerRefused({
      args: [
        'reply',
        'next',
        '--text',
        'Hold unresolved handoff',
      ],
    })).code).toBe('CONFLICT')
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
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Bystander',
        '--key',
        'bystander',
        '--project',
        'shop',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'bystander',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'status',
        'bystander',
        'done',
      ],
    })
    await until({
      what: 'Done cleanup settles another copy while the handoff stays unresolved',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'bystander',
          '--full',
        ],
      })).task.copy?.state === 'removed',
    })
  },
  RESTART_FLOW_TIMEOUT_MS,
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

test(
  'Hydra merges a private repository whose branch rules GitHub hides while enforcing approval and readable checks',
  async () => {
    const repo = 'private'
    const rulesError = 'error: "Insufficient permissions for this action"\ncode: FORBIDDEN'
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
    // Every way GitHub hides a private repository's rules counts as hidden, not unreadable; unreadable classic protection keeps the merge refused.
    publish({
      error: 'error: HTTP 404: Not Found',
      classic: {},
    })
    const hiddenAs404 = await asHydra.refused({ args: merge })
    expect(hiddenAs404.code).toBe('CONFLICT')
    expect(hiddenAs404.error).toContain('classic protection unreadable')
    expect(hiddenAs404.error).not.toContain('branch rules unreadable')
    publish({
      error: 'error: HTTP 403: Forbidden',
      classic: {},
    })
    const hiddenAs403 = await asHydra.refused({ args: merge })
    expect(hiddenAs403.code).toBe('CONFLICT')
    expect(hiddenAs403.error).toContain('classic protection unreadable')
    expect(hiddenAs403.error).not.toContain('branch rules unreadable')
    publish({
      error: 'error: "Resource not found"\ncode: NOT_FOUND',
      classic: {},
    })
    const hiddenAsNotFound = await asHydra.refused({ args: merge })
    expect(hiddenAsNotFound.code).toBe('CONFLICT')
    expect(hiddenAsNotFound.error).toContain('classic protection unreadable')
    expect(hiddenAsNotFound.error).not.toContain('branch rules unreadable')
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
  'attaching a repository to another Hydra refuses without moving existing work',
  async () => {
    const owner = await pnyx.hydra()
    const other = await pnyx.hydra()
    const path = owner.folder({ name: 'owned-project' })
    await owner.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const task = await owner.owner({
      args: [
        'task',
        'create',
        '--title',
        'Keep this work',
        '--project',
        path,
      ],
    })
    const refused = await other.ownerRefused({
      args: [
        'project',
        'add',
        path,
      ],
    })
    expect(refused.code).toBe('CONFLICT')
    expect(refused.error).toContain(owner.id)
    expect((await owner.task({ key: task.card.id })).title).toBe('Keep this work')
    expect((await other.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toBe('none: no projects attached')
  },
)

test(
  'legacy duplicates stay usable until an atomic keeper choice clears all task blockers',
  async () => {
    const owner = await pnyx.hydra()
    const path = owner.folder({ name: 'legacy-shared' })
    await owner.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const id = 'legacy-project-owner'
    const folder = join(
      process.env.PNYX_HOME!,
      'hydras',
      id,
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    writeFileSync(
      join(
        folder,
        'events.jsonl',
      ),
      `${JSON.stringify({
        v: 1,
        seq: 1,
        id: 'legacy-project',
        at: '2026-10-21T10:01:00Z',
        actor: 'cli',
        cardId: '$projects',
        type: 'hydra.project',
        data: {
          before: null,
          after: {
            path,
            name: 'legacy-shared',
            detached: false,
          },
          sharedWith: [],
        },
      })}\n`,
    )
    const legacy = await pnyx.hydra({
      id,
      create: false,
    })
    const task = await legacy.owner({
      args: [
        'task',
        'create',
        '--title',
        'Legacy work',
        '--project',
        path,
      ],
    })
    expect((await legacy.task({ key: task.card.id })).project).toBe('legacy-shared')
    await legacy.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const setupRun = await pnyxAxi({
      env: process.env,
      args: [
        'setup',
        'check',
        '--hydra',
        legacy.id,
      ],
    })
    expect(setupRun.status).toBe(1)
    const setup = parsed(setupRun)
    expect(setup.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: `project-owner:${path}`,
        missing: expect.stringContaining(owner.id),
        by: 'owner',
      }),
    ]))
    expect(setup.missing.find((item: { name: string }) => item.name === `project-owner:${path}`).missing).toContain(legacy.id)
    expect((await owner.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path,
        state: 'attached',
      }),
    ]))
    const dependent = await legacy.owner({
      args: [
        'task',
        'create',
        '--title',
        'Dependent work',
        '--project',
        path,
      ],
    })
    const free = await legacy.owner({
      args: [
        'task',
        'create',
        '--title',
        'Independent work',
        '--project',
        path,
      ],
    })
    await legacy.owner({
      args: [
        'task',
        'depend',
        dependent.card.id,
        '--on',
        task.card.id,
      ],
    })
    const refused = await owner.ownerRefused({
      args: [
        'project',
        'keep',
        path,
      ],
    })
    expect(refused.code).toBe('CONFLICT')
    expect(refused.error).toContain(task.card.id)
    expect(refused.error).toContain(dependent.card.id)
    expect((await legacy.task({ key: free.card.id })).title).toBe('Independent work')
    expect((await legacy.task({ key: task.card.id })).title).toBe('Legacy work')
    expect((await legacy.task({ key: dependent.card.id })).title).toBe('Dependent work')
    expect((await owner.ownerRefused({
      args: [
        'task',
        'show',
        free.card.id,
      ],
    })).code).toBe('NOT_FOUND')
    await legacy.owner({
      args: [
        'task',
        'undepend',
        dependent.card.id,
        '--on',
        task.card.id,
      ],
    })
    const extra = legacy.folder({ name: 'legacy-extra' })
    await legacy.owner({
      args: [
        'project',
        'add',
        extra,
      ],
    })
    expect((await owner.ownerRefused({
      args: [
        'project',
        'keep',
        path,
        '--if-revision',
        '0',
      ],
    })).code).toBe('REVISION_CONFLICT')
    const kept = await owner.owner({
      args: [
        'project',
        'keep',
        path,
        '--if-revision',
        '1',
      ],
    })
    expect(kept.moved).toEqual(expect.arrayContaining([
      task.card.id,
      dependent.card.id,
      free.card.id,
    ]))
    expect((await owner.task({ key: task.card.id })).title).toBe('Legacy work')
    expect((await owner.task({ key: dependent.card.id })).title).toBe('Dependent work')
    expect((await owner.task({ key: free.card.id })).title).toBe('Independent work')
    expect(rows({
      text: 'select hydra_id, type from events where card_id = $1 and type in (\'task.moved-in\', \'task.moved-out\') order by type',
      values: [task.card.id],
    })).toEqual([
      {
        hydra_id: owner.id,
        type: 'task.moved-in',
      },
      {
        hydra_id: legacy.id,
        type: 'task.moved-out',
      },
    ])
    expect((await legacy.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toEqual([
      expect.objectContaining({
        path: extra,
        state: 'attached',
      }),
      expect.objectContaining({
        path,
        state: 'detached',
      }),
    ])
    expect((await owner.owner({
      args: [
        'project',
        'keep',
        path,
      ],
    })).moved).toEqual([])
  },
)

test(
  'parent-folder attachment preserves rules, guards one revision and retries once',
  async () => {
    const hydra = await pnyx.hydra()
    const parent = hydra.folder({ name: 'repositories' })
    const first = join(
      parent,
      'atlas',
    )
    const second = join(
      parent,
      'boreal',
    )
    mkdirSync(
      join(
        first,
        '.git',
      ),
      { recursive: true },
    )
    mkdirSync(
      join(
        second,
        '.git',
      ),
      { recursive: true },
    )
    const args = [
      'project',
      'add',
      parent,
      '--landing',
      'branch',
      '--merge',
      'hydra',
      '--if-revision',
      '0',
      '--event-id',
      'constructor',
    ]
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { chatCollapsed: true } }),
        '--event-id',
        'constructor:0',
      ],
    })
    await hydra.owner({ args })
    expect((await hydra.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toEqual([
      expect.objectContaining({
        path: first,
        landing: 'branch',
        merge: 'hydra',
      }),
      expect.objectContaining({
        path: second,
        landing: 'branch',
        merge: 'hydra',
      }),
    ])
    const noOpArgs = [
      ...args.slice(
        0,
        -4,
      ),
      '--if-revision',
      String((await hydra.owner({
        args: [
          'project',
          'list',
        ],
      })).revision),
      '--event-id',
      '__proto__',
    ]
    await hydra.owner({ args: noOpArgs })
    await pnyx.restart()
    const third = join(
      parent,
      'cedar',
    )
    mkdirSync(
      join(
        third,
        '.git',
      ),
      { recursive: true },
    )
    await hydra.owner({ args: noOpArgs })
    await hydra.owner({ args })
    expect((await hydra.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toHaveLength(2)
    expect((await hydra.ownerRefused({
      args: [
        'project',
        'add',
        parent,
        '--if-revision',
        '0',
      ],
    })).code).toBe('REVISION_CONFLICT')
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
    const titleHydra = await pnyx.hydra()
    const titleProject = await createProject({
      hydra: titleHydra,
      landing: 'branch',
    })
    await titleHydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Poséidon!',
      ],
    })

    const start = async ({
      title,
      key,
    }: {
      title: string
      key: string
    }) => {
      await titleHydra.owner({
        args: [
          'task',
          'create',
          '--title',
          title,
          '--key',
          key,
          '--project',
          'shop',
        ],
      })
      const started = await titleHydra.owner({
        args: [
          'task',
          'start',
          key,
        ],
      })

      const { id } = await titleHydra.task({ key })

      if (typeof id !== 'string') {
        throw new Error('Expected the created task ID')
      }

      return {
        id,
        branch: git({
          cwd: started.agent.folder,
          args: [
            'branch',
            '--show-current',
          ],
        }),
      }
    }

    expect((await start({
      title: 'Clientes atendídos / ven\u1ab0das: chart!',
      key: 'accents',
    })).branch).toBe('poseidon/clientes-atendidos-vendas-chart')
    expect((await start({
      title: 'The chart of the vendas and clientes atendidos across projects',
      key: 'filler',
    })).branch).toBe('poseidon/chart-vendas-clientes-atendidos-across')
    const punctuation = await start({
      title: '!!!',
      key: 'punctuation',
    })
    expect(punctuation.branch).toBe(`poseidon/${punctuation.id.replace(
      /^task-/,
      '',
    ).slice(
      0,
      8,
    )}`)
    git({
      cwd: titleProject,
      args: [
        'commit',
        '--allow-empty',
        '-m',
        'Local project commit',
      ],
    })
    git({
      cwd: titleProject,
      args: [
        'branch',
        'origin/main',
      ],
    })
    git({
      cwd: titleProject,
      args: [
        'branch',
        'Poseidon/Chart',
      ],
    })
    git({
      cwd: titleProject,
      args: [
        'push',
        'origin',
        'HEAD:refs/heads/poseidon/chart-2',
      ],
    })
    expect((await start({
      title: 'Chart',
      key: 'head-chart',
    })).branch).toBe('poseidon/chart-3')
    expect(git({
      cwd: titleProject,
      args: [
        'log',
        '-1',
        '--format=%s',
        'refs/heads/poseidon/chart-3',
      ],
    })).toBe('init')
    await titleHydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'HEAD',
      ],
    })
    expect((await start({
      title: 'Symref',
      key: 'symref',
    })).branch).toBe('head-2/symref')
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
    git({
      cwd,
      args: [
        'remote',
        'add',
        'unavailable',
        join(
          cwd,
          'missing-remote.git',
        ),
      ],
    })
    expect(await hydra.ownerRefused({
      args: [
        'task',
        'start',
        'chart',
      ],
    })).toMatchObject({
      code: 'COPY_FAILED',
      error: expect.stringContaining('remote unavailable'),
    })
    expect(git({
      cwd,
      args: [
        'branch',
        '--list',
        'poseidon-2/chart-2',
      ],
    })).toBe('')
    git({
      cwd,
      args: [
        'remote',
        'remove',
        'unavailable',
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
    await hydra.owner({
      args: [
        'task',
        'detach',
        'chart',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'copy',
        'chart',
        'remove',
        '--safe',
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
      '#!/bin/sh\necho "fixture copy hook failure" >&2\nexit 1\n',
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
    })).toMatchObject({
      code: 'COPY_FAILED',
      error: expect.stringContaining('fixture copy hook failure'),
    })
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
    writeFileSync(
      join(
        failingHooks,
        'post-checkout',
      ),
      '#!/bin/sh\ngit update-ref --no-deref HEAD "$(git rev-parse HEAD)"\n',
    )
    expect(await hydra.ownerRefused({
      args: [
        'task',
        'start',
        'retry',
      ],
    })).toMatchObject({
      code: 'COPY_FAILED',
      error: expect.stringContaining('did not stay on branch poseidon-2/retry-allocation-2'),
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
    })).toBe('poseidon-2/retry-allocation-3')
    expect(git({
      cwd,
      args: [
        'rev-parse',
        'refs/heads/poseidon-2/retry-allocation',
      ],
    })).toBe(reserved)
    const other = await legacyDuplicate({
      pnyx,
      id: 'legacy-branch-names',
      projects: [
        {
          path: cwd,
          landing: 'branch',
        },
      ],
    })
    await other.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Póseídon',
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
    await hydra.owner({
      args: [
        'task',
        'rename',
        'chart',
        '--title',
        'Renamed chart',
      ],
    })
    const reopened = await hydra.owner({
      args: [
        'task',
        'start',
        'chart',
      ],
    })
    expect(git({
      cwd: reopened.agent.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('poseidon-2/chart-2')
  },
)

test(
  'a server killed mid-handoff gets the source checkout back before the commit and keeps the target after it, refusing work on both tasks while changed work blocks recovery',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Iris',
      ],
    })
    const project = await createProject({
      hydra,
      landing: 'branch',
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Source',
        '--key',
        'source',
        '--project',
        'shop',
      ],
    })
    const started = await hydra.owner({
      args: [
        'task',
        'start',
        'source',
      ],
    })
    const cwd = started.agent.folder as string
    await hydra.agent({ cwd })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Target',
        '--key',
        'target',
        '--project',
        'shop',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'brief',
        'target',
        '--brief',
        'Prepare target',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Gate',
        '--key',
        'gate',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'depend',
        'target',
        '--on',
        'gate',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'queue',
        'target',
        '--behind',
        'source',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'status',
        'source',
        'done',
      ],
    })
    await pnyx.stop()
    const hooks = join(
      project,
      'crash-hooks',
    )
    const marker = join(
      project,
      'crashed',
    )
    mkdirSync(hooks)
    writeFileSync(
      join(
        hooks,
        'post-checkout',
      ),
      `#!${process.execPath}
const { execFileSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
if (branch === 'iris/target') {
  execFileSync(process.execPath, ${JSON.stringify([
    CLI,
    'task',
    'depend',
    'target',
    '--on',
    'gate',
    '--hydra',
    hydra.id,
  ])})
  writeFileSync(${JSON.stringify(marker)}, branch)
  process.kill(Number(process.env.PNYX_HANDOFF_CRASH_PID), 'SIGKILL')
}
`,
      { mode: 0o700 },
    )
    git({
      cwd: project,
      args: [
        'config',
        'core.hooksPath',
        hooks,
      ],
    })
    let ready = false
    let ended = false
    let errors = ''

    const launch = ({ afterCommit }: { afterCommit: boolean }) => {
      ready = false
      ended = false
      errors = ''
      const child = spawn(
        process.execPath,
        [
          '--conditions=source',
          join(
            import.meta.dirname,
            'setup',
            'fixtures',
            'handoff-server.ts',
          ),
        ],
        {
          env: {
            ...process.env,
            PNYX_CRASH_HYDRA: hydra.id,
            PNYX_CRASH_AFTER_COMMIT: afterCommit ? cwd : '',
          },
          stdio: [
            'ignore',
            'pipe',
            'pipe',
            'ipc',
          ],
        },
      )
      child.on(
        'message',
        message => ready = message === 'ready',
      )
      child.on(
        'exit',
        () => ended = true,
      )
      child.stderr!.on(
        'data',
        chunk => errors += String(chunk),
      )

      return child
    }

    const childReady = () => {
      if (ended) {
        throw new Error(errors)
      }

      return ready
    }

    let child = launch({ afterCommit: false })

    try {
      await until({
        what: 'scratch child server ready',
        check: childReady,
      })
      await hydra.owner({
        args: [
          'task',
          'undepend',
          'target',
          '--on',
          'gate',
        ],
      })
      await until({
        what: 'checkout hook kills the server before handoff commit',
        check: () => ended,
      })
      expect(readFileSync(
        marker,
        'utf8',
      )).toBe('iris/target')
      expect(git({
        cwd,
        args: [
          'branch',
          '--show-current',
        ],
      })).toBe('iris/target')
      const kept = join(
        cwd,
        'keep.txt',
      )
      writeFileSync(
        kept,
        'unfinished work',
      )
      git({
        cwd: project,
        args: [
          'config',
          'status.showUntrackedFiles',
          'no',
        ],
      })
      await pnyx.start()
      await hydra.task({ key: 'source' })
      expect(readFileSync(
        kept,
        'utf8',
      )).toBe('unfinished work')
      expect(git({
        cwd,
        args: [
          'branch',
          '--show-current',
        ],
      })).toBe('iris/target')
      rmSync(kept)
      expect(await hydra.ownerRefused({
        args: [
          'task',
          'copy',
          'source',
          'remove',
          '--safe',
        ],
      })).toMatchObject({
        code: 'CONFLICT',
        error: expect.stringContaining('unresolved handoff'),
      })
      expect(await hydra.ownerRefused({
        args: [
          'task',
          'start',
          'target',
        ],
      })).toMatchObject({
        code: 'CONFLICT',
        error: expect.stringContaining('unresolved handoff'),
      })
      expect(existsSync(cwd)).toBe(true)
      await pnyx.restart()
      const source = (await hydra.owner({
        args: [
          'task',
          'show',
          'source',
          '--full',
        ],
      })).task
      const target = (await hydra.owner({
        args: [
          'task',
          'show',
          'target',
          '--full',
        ],
      })).task
      expect(source.sessionIds).toHaveLength(1)
      expect(target.sessionIds ?? []).toEqual([])
      expect(git({
        cwd,
        args: [
          'branch',
          '--show-current',
        ],
      })).toBe('iris/source')
      expect(git({
        cwd,
        args: [
          'branch',
          '--list',
          'iris/target',
        ],
      })).toContain('iris/target')
      await pnyx.stop()
      child = launch({ afterCommit: true })
      await until({
        what: 'second scratch server ready',
        check: childReady,
      })
      await hydra.owner({
        args: [
          'task',
          'undepend',
          'target',
          '--on',
          'gate',
        ],
      })
      await until({
        what: 'server killed after durable handoff commit',
        check: () => ended,
      })
      const committedWork = join(
        cwd,
        'committed-work.txt',
      )
      writeFileSync(
        committedWork,
        'keep committed-checkout work',
      )
      await pnyx.start()
      const blockedTarget = (await hydra.owner({
        args: [
          'task',
          'show',
          'target',
          '--full',
        ],
      })).task
      expect((await hydra.ownerRefused({
        args: [
          'reply',
          'target',
          '--text',
          'Hold the dirty target',
        ],
      })).code).toBe('CONFLICT')
      expect(blockedTarget.replies ?? []).toEqual([])
      expect(readFileSync(
        committedWork,
        'utf8',
      )).toBe('keep committed-checkout work')
      rmSync(committedWork)
      await pnyx.restart()
      const committedTarget = (await hydra.owner({
        args: [
          'task',
          'show',
          'target',
          '--full',
        ],
      })).task
      const committedSource = (await hydra.owner({
        args: [
          'task',
          'show',
          'source',
          '--full',
        ],
      })).task
      expect(committedTarget.sessionIds).toEqual(source.sessionIds)
      expect(committedSource.sessionIds ?? []).toEqual([])
      expect(git({
        cwd,
        args: [
          'branch',
          '--show-current',
        ],
      })).toBe('iris/target-2')
      await until({
        what: 'recovered target receives its committed brief',
        check: async () => (await hydra.agent({ cwd })).received.some(text => text.includes('on fresh branch iris/target-2')),
      })
      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          'Final',
          '--key',
          'final',
          '--project',
          'shop',
        ],
      })
      await hydra.owner({
        args: [
          'task',
          'brief',
          'final',
          '--brief',
          'Continue after recovery',
        ],
      })
      await hydra.owner({
        args: [
          'task',
          'queue',
          'final',
          '--behind',
          'target',
        ],
      })
      await hydra.as({ session: await hydra.agent({ cwd }) }).run({
        args: [
          'task',
          'status',
          'target',
          'done',
        ],
      })
      // The scratch server checks its queue again every 100 ms; the shared one waits 30 seconds after its check on start.
      await pnyx.stop()
      child = launch({ afterCommit: false })
      await until({
        what: 'third scratch server ready',
        check: childReady,
      })
      await until({
        what: 'worker advances again after committed intent recovery',
        check: async () => (await hydra.owner({
          args: [
            'task',
            'copy',
            'final',
          ],
        })).copy?.branch === 'iris/final',
      })
    } finally {
      if (!ended) {
        child.kill('SIGKILL')
      }

      git({
        cwd: project,
        args: [
          'config',
          '--unset',
          'core.hooksPath',
        ],
      })

      if (!ended) {
        await until({
          what: 'child server exits',
          check: () => ended,
        })
      }

      await pnyx.restart()
    }
  },
  RESTART_FLOW_TIMEOUT_MS,
)

test(
  'a project reassigned by a checkout hook refuses the old copy and starts in the new project',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Iris',
      ],
    })
    const project = await createProject({
      hydra,
      landing: 'branch',
    })
    const other = await createProject({
      hydra,
      landing: 'branch',
      name: 'other',
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Reassign',
        '--key',
        'drift',
        '--project',
        'shop',
      ],
    })
    const hooks = join(
      project,
      'drift-hooks',
    )
    const orphanMarker = join(
      project,
      'unrecorded-folder',
    )
    mkdirSync(hooks)
    writeFileSync(
      join(
        hooks,
        'post-checkout',
      ),
      `#!${process.execPath}
const { execFileSync } = require('node:child_process')
require('node:fs').writeFileSync(${JSON.stringify(orphanMarker)}, process.cwd())
execFileSync(process.execPath, ${JSON.stringify([
  CLI,
  'task',
  'project',
  'drift',
  '--project',
  'other',
  '--hydra',
  hydra.id,
])})
`,
      { mode: 0o700 },
    )
    git({
      cwd: project,
      args: [
        'config',
        'core.hooksPath',
        hooks,
      ],
    })

    try {
      expect((await hydra.ownerRefused({
        args: [
          'task',
          'start',
          'drift',
        ],
      })).code).toBe('CONFLICT')
      const moved = (await hydra.owner({
        args: [
          'task',
          'show',
          'drift',
          '--full',
        ],
      })).task
      expect(moved.project).toBe(other)
      expect(moved.copy).toBeUndefined()
      expect(moved.sessionIds ?? []).toEqual([])
    } finally {
      git({
        cwd: project,
        args: [
          'config',
          '--unset',
          'core.hooksPath',
        ],
      })
    }

    await hydra.owner({
      args: [
        'task',
        'start',
        'drift',
      ],
    })
    expect((await hydra.owner({
      args: [
        'task',
        'copy',
        'drift',
      ],
    })).copy.project).toBe(other)
    const orphan = readFileSync(
      orphanMarker,
      'utf8',
    )
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Reuse clean slot',
        '--key',
        'reuse',
        '--project',
        'shop',
      ],
    })
    const reused = await hydra.owner({
      args: [
        'task',
        'start',
        'reuse',
      ],
    })
    expect(reused.agent.folder).toBe(orphan)
    expect(git({
      cwd: project,
      args: [
        'branch',
        '--list',
        'iris/reassign',
      ],
    })).toContain('iris/reassign')
  },
)

test(
  'unrecorded slots preserve and report dirty or unlanded work, then reuse it after landing',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Iris',
      ],
    })
    const project = await createProject({
      hydra,
      landing: 'branch',
    })
    const hooks = join(
      project,
      'unrecorded-hooks',
    )
    const marker = join(
      project,
      'unrecorded-path',
    )
    mkdirSync(hooks)
    writeFileSync(
      join(
        hooks,
        'post-checkout',
      ),
      `#!${process.execPath}
const { writeFileSync } = require('node:fs')
writeFileSync(${JSON.stringify(marker)}, process.cwd())
writeFileSync('keep.txt', 'unfinished work')
throw new Error('fixture allocation refusal')
`,
      { mode: 0o700 },
    )
    git({
      cwd: project,
      args: [
        'config',
        'core.hooksPath',
        hooks,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Unrecorded',
        '--key',
        'unrecorded',
        '--project',
        'shop',
      ],
    })

    try {
      expect((await hydra.ownerRefused({
        args: [
          'task',
          'start',
          'unrecorded',
        ],
      })).code).toBe('COPY_FAILED')
    } finally {
      git({
        cwd: project,
        args: [
          'config',
          '--unset',
          'core.hooksPath',
        ],
      })
    }

    const orphan = readFileSync(
      marker,
      'utf8',
    )
    git({
      cwd: project,
      args: [
        'config',
        'status.showUntrackedFiles',
        'no',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Next',
        '--key',
        'next',
        '--project',
        'shop',
      ],
    })
    const other = await createProject({
      hydra,
      landing: 'branch',
      name: 'other',
    })
    const foreignSlot = join(
      orphan,
      '..',
      'shop-0',
    )
    git({
      cwd: other,
      args: [
        'worktree',
        'add',
        '--detach',
        foreignSlot,
        'main',
      ],
    })
    writeFileSync(
      join(
        foreignSlot,
        'foreign.txt',
      ),
      'another project’s work',
    )
    const next = await hydra.owner({
      args: [
        'task',
        'start',
        'next',
      ],
    })
    expect(next.agent.folder).not.toBe(orphan)
    expect(readFileSync(
      join(
        orphan,
        'keep.txt',
      ),
      'utf8',
    )).toBe('unfinished work')
    const dirtyMessages = await hydra.owner({
      args: [
        'hydra',
        'messages',
        '--full',
      ],
    })
    expect(JSON.stringify(dirtyMessages.messages)).not.toContain(foreignSlot)
    expect(readFileSync(
      join(
        foreignSlot,
        'foreign.txt',
      ),
      'utf8',
    )).toBe('another project’s work')
    expect(dirtyMessages.messages.find((event: { data: { text: string } }) => event.data.text.includes(orphan) && event.data.text.includes('uncommitted'))).toBeDefined()
    git({
      cwd: orphan,
      args: [
        'add',
        'keep.txt',
      ],
    })
    git({
      cwd: orphan,
      args: [
        'commit',
        '-qm',
        'Unlanded work',
      ],
    })
    const unlanded = git({
      cwd: orphan,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Later',
        '--key',
        'later',
        '--project',
        'shop',
      ],
    })
    const later = await hydra.owner({
      args: [
        'task',
        'start',
        'later',
      ],
    })
    expect(later.agent.folder).not.toBe(orphan)
    expect(git({
      cwd: orphan,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })).toBe(unlanded)
    const unlandedMessages = await hydra.owner({
      args: [
        'hydra',
        'messages',
        '--full',
      ],
    })
    expect(unlandedMessages.messages.find((event: { data: { text: string } }) => event.data.text.includes(orphan) && event.data.text.includes('not landed'))).toBeDefined()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Still unlanded',
        '--key',
        'again',
        '--project',
        'shop',
      ],
    })
    const again = await hydra.owner({
      args: [
        'task',
        'start',
        'again',
      ],
    })
    expect(again.agent.folder).not.toBe(orphan)
    const repeated = await hydra.owner({
      args: [
        'hydra',
        'messages',
        '--full',
      ],
    })
    const orphanNotices = repeated.messages.filter(
      (event: { data: { text: string } }) => event.data.text.includes(orphan),
    )
    expect(orphanNotices).toHaveLength(2)
    git({
      cwd: orphan,
      args: [
        'push',
        'origin',
        'HEAD:refs/heads/main',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Recovered',
        '--key',
        'recovered',
        '--project',
        'shop',
      ],
    })
    const recovered = await hydra.owner({
      args: [
        'task',
        'start',
        'recovered',
      ],
    })
    expect(recovered.agent.folder).toBe(orphan)
    expect(readFileSync(
      join(
        orphan,
        'keep.txt',
      ),
      'utf8',
    )).toBe('unfinished work')
    expect(git({
      cwd: orphan,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('iris/recovered')
    expect(git({
      cwd: project,
      args: [
        'rev-parse',
        'iris/unrecorded',
      ],
    })).toBe(unlanded)
  },
)

test(
  'helper-agent records do not block keeper selection or individual task moves',
  async () => {
    const keeper = await pnyx.hydra()
    const path = keeper.folder({ name: 'helpers-project' })
    await keeper.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const source = await legacyDuplicate({
      pnyx,
      id: 'helper-project-source',
      projects: [
        {
          path,
          landing: 'branch',
        },
      ],
    })
    const created = await source.owner({
      args: [
        'task',
        'create',
        '--title',
        'Finished work',
        '--project',
        path,
      ],
    })
    const parent = created.card.id
    const helper = await source.owner({
      args: [
        'push',
        '--key',
        'helper-record',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'general-purpose helper',
        parent,
        activity: 'finished',
        agent: {
          provider: 'claude',
          sessionId: 'helper-session',
          agentId: 'helper',
        },
        source: {
          adapter: 'hooks',
          objectId: 'helper-record',
        },
      }),
    })
    const workChild = await source.owner({
      args: [
        'task',
        'create',
        '--title',
        'Real subtask',
        '--project',
        path,
      ],
    })
    await source.owner({
      args: [
        'task',
        'parent',
        workChild.card.id,
        parent,
      ],
    })
    expect((await source.ownerRefused({
      args: [
        'task',
        'move',
        parent,
        '--to-hydra',
        keeper.id,
      ],
    })).code).toBe('CONFLICT')
    expect((await keeper.ownerRefused({
      args: [
        'project',
        'keep',
        path,
      ],
    })).code).toBe('CONFLICT')
    await source.owner({
      args: [
        'task',
        'parent',
        workChild.card.id,
        'none',
      ],
    })
    await keeper.owner({
      args: [
        'project',
        'keep',
        path,
      ],
    })
    expect((await keeper.task({ key: parent })).title).toBe('Finished work')
    expect((await source.task({ key: helper.card.id })).id).toBe(helper.card.id)
    expect((await keeper.ownerRefused({
      args: [
        'task',
        'show',
        helper.card.id,
      ],
    })).code).toBe('NOT_FOUND')
    const target = await pnyx.hydra()
    await keeper.owner({
      args: [
        'project',
        'remove',
        path,
      ],
    })
    await target.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const secondHelper = await keeper.owner({
      args: [
        'push',
        '--key',
        'second-helper',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Second helper',
        parent,
        activity: 'finished',
        agent: {
          provider: 'codex',
          sessionId: 'second-session',
          agentId: 'second',
        },
        source: {
          adapter: 'hooks',
          objectId: 'second-helper',
        },
      }),
    })
    await keeper.owner({
      args: [
        'task',
        'move',
        parent,
        '--to-hydra',
        target.id,
      ],
    })
    expect((await target.task({ key: parent })).title).toBe('Finished work')
    expect((await keeper.task({ key: secondHelper.card.id })).id).toBe(secondHelper.card.id)
    expect((await target.ownerRefused({
      args: [
        'task',
        'show',
        secondHelper.card.id,
      ],
    })).code).toBe('NOT_FOUND')
  },
)

test(
  'attachment management survives an empty memory read list without revealing memory',
  async () => {
    const source = await pnyx.hydra()
    const target = await pnyx.hydra()
    const path = source.folder({ name: 'hidden-memory-project' })
    await source.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    await source.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'preferences',
        '--text',
        'Private memory sentinel',
      ],
    })
    await source.owner({
      args: [
        'hydra',
        'set',
        '--read-poleis',
        '',
      ],
    })
    expect((await target.ownerRefused({
      args: [
        'project',
        'add',
        path,
      ],
    })).code).toBe('CONFLICT')
    expect((await source.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toEqual([
      expect.objectContaining({
        path,
        state: 'attached',
      }),
    ])
    const shown = await source.owner({
      args: [
        'project',
        'show',
        path,
      ],
    })
    expect(shown).not.toHaveProperty('memory')
    expect(shown.attachment).toEqual(expect.objectContaining({
      path,
      state: 'attached',
    }))
    expect((await source.ownerRefused({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        path,
      ],
    })).code).toBe('NOT_FOUND')
    const env = {
      ...process.env,
      PNYX_ACTOR: 'hydra',
      PNYX_HYDRA: source.id,
      PNYX_TASK: undefined,
    }
    const foreignHydra = {
      ...env,
      PNYX_HYDRA: target.id,
    }
    const foreignProjects = parsed(await pnyxAxi({
      env: foreignHydra,
      args: [
        'project',
        'list',
        '--hydra',
        source.id,
      ],
    }))
    expect(foreignProjects.projects).toBe('none: no projects attached')
    expect(foreignProjects.help ?? []).not.toContainEqual(expect.stringContaining('project add'))
    expect((await pnyxAxi({
      env: foreignHydra,
      args: [
        'project',
        'show',
        path,
        '--hydra',
        source.id,
      ],
    })).stdout).toContain('NOT_FOUND')
    expect((await pnyxAxi({
      env: foreignHydra,
      args: [
        'project',
        'remove',
        path,
        '--reason',
        'Attempt to detach another Hydra attachment',
        '--hydra',
        source.id,
      ],
    })).stdout).toContain('NOT_FOUND')
    expect(parsed(await pnyxAxi({
      env,
      args: [
        'project',
        'list',
        '--hydra',
        source.id,
      ],
    })).projects).toEqual([expect.objectContaining({ path })])
    const shownToHydra = parsed(await pnyxAxi({
      env,
      args: [
        'project',
        'show',
        path,
        '--hydra',
        source.id,
      ],
    }))
    expect(shownToHydra.attachment).toEqual(expect.objectContaining({ path }))
    expect(shownToHydra).not.toHaveProperty('memory')
    const removed = await pnyxAxi({
      env,
      args: [
        'project',
        'remove',
        path,
        '--reason',
        'Detach attachment without memory access',
        '--hydra',
        source.id,
      ],
    })
    expect(removed.status).toBe(0)
    await target.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    expect((await target.owner({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        path,
      ],
    })).memory.preferences).toBe('Private memory sentinel')
  },
)

test(
  'ready review becomes an update when its task changes to Hydra merges',
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
        'Review cart',
        '--key',
        'review-update',
        '--project',
        'shop',
      ],
    })
    const url = 'https://github.com/o/shop/pull/77'
    writeFileSync(
      join(
        github,
        'o',
        'shop',
        '77.json',
      ),
      JSON.stringify({
        state: 'open',
        title: 'Review cart',
        head: 'd'.repeat(40),
        checks: '1 passed, 0 failed, 1 total',
      }),
    )
    await hydra.owner({
      args: [
        'link',
        'review-update',
        '--url',
        url,
      ],
    })
    const question = await until({
      what: 'an owner merge decision',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'review-update',
          '--full',
        ],
      })).task.asks?.find((ask: { kind: string }) => ask.kind === 'merge'),
    })
    const landingReceipt = await hydra.owner({
      args: [
        'task',
        'landing',
        'review-update',
        '--landing',
        'pr',
        '--merge',
        'hydra',
      ],
    })
    const current = await hydra.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    const retired = current.task.asks.find((ask: { id: string }) => ask.id === question.id)
    expect(retired).toMatchObject({ closed: { at: expect.any(String) } })
    const events = await readEvents({ hydraId: hydra.id })
    const landingEvent = events.find(event => event.id === landingReceipt.event.id)
    expect(landingEvent).toMatchObject({
      type: 'task.landing',
      at: retired?.closed?.at,
    })
    expect(landingReceipt.card.column).toBe(current.task.column)
    expect(landingReceipt.card.revision).toBe(current.task.revision)
    expect(current.task.column).not.toBe(await hydra.column({ role: 'needs_you' }))
    const updates = await hydra.owner({
      args: [
        'task',
        'updates',
        'review-update',
      ],
    })
    expect(JSON.stringify(updates)).toContain(url)
    await hydra.owner({
      args: [
        'task',
        'landing',
        'review-update',
        '--landing',
        'pr',
        '--merge',
        'owner',
      ],
    })
    const restored = await hydra.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    expect(restored.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(1)
    const alias = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Shared review',
        '--project',
        'shop',
      ],
    })
    await hydra.owner({
      args: [
        'link',
        alias.card.id,
        '--url',
        url,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'landing',
        'review-update',
        '--landing',
        'pr',
        '--merge',
        'hydra',
      ],
    })
    const shared = await hydra.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    expect(shared.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(1)
    await hydra.owner({
      args: [
        'outcome',
        alias.card.id,
        'cancelled',
        '--note',
        'Shared review was abandoned',
      ],
    })
    const settled = await hydra.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    expect(settled.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(0)
    await hydra.owner({
      args: [
        'task',
        'landing',
        'review-update',
        '--clear',
      ],
    })
    const beforeProjectChange = await hydra.owner({
      args: [
        'task',
        'show',
        'review-update',
        '--full',
      ],
    })
    const taskId = beforeProjectChange.task.id
    const pendingBeforeMove = beforeProjectChange.task.asks.filter((ask: { closed?: unknown }) =>
      !ask.closed)
    expect(pendingBeforeMove).toHaveLength(1)
    const destination = hydra.folder({ name: 'hydra-merges' })
    await hydra.owner({
      args: [
        'project',
        'add',
        destination,
        '--landing',
        'pr',
        '--merge',
        'hydra',
      ],
    })
    const projectReceipt = await hydra.owner({
      args: [
        'task',
        'project',
        taskId,
        '--project',
        destination,
      ],
    })
    const moved = await hydra.owner({
      args: [
        'task',
        'show',
        taskId,
        '--full',
      ],
    })
    expect(moved.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(0)
    expect(moved.task.asks).toContainEqual(expect.objectContaining({
      id: pendingBeforeMove[0].id,
      closed: expect.any(Object),
    }))
    expect(projectReceipt.event.type).toBe('task.project')
    expect(projectReceipt.card.column).toBe(moved.task.column)
    expect(projectReceipt.card.revision).toBe(moved.task.revision)
    await hydra.owner({
      args: [
        'task',
        'project',
        taskId,
        '--project',
        'shop',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'landing',
        taskId,
        '--landing',
        'pr',
        '--merge',
        'owner',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'landing',
        taskId,
        '--clear',
      ],
    })
    const beforePush = await hydra.owner({
      args: [
        'task',
        'show',
        taskId,
        '--full',
      ],
    })
    const pendingBeforePush = beforePush.task.asks.filter((ask: { closed?: unknown }) =>
      !ask.closed)
    expect(pendingBeforePush).toHaveLength(1)
    const renamed = await hydra.owner({
      args: [
        'push',
        '--key',
        'review-update',
        '--file',
        '-',
      ],
      input: JSON.stringify({ title: 'Review the CSV export' }),
    })
    const afterRename = await hydra.owner({
      args: [
        'task',
        'show',
        taskId,
        '--full',
      ],
    })
    expect(renamed.card.id).toBe(taskId)
    expect(afterRename.task.title).toBe('Review the CSV export')
    const pendingAfterRename = afterRename.task.asks.filter((ask: { closed?: unknown }) =>
      !ask.closed)
    expect(pendingAfterRename).toEqual(pendingBeforePush)
    const pushed = await hydra.owner({
      args: [
        'push',
        '--key',
        'review-update',
        '--file',
        '-',
      ],
      input: JSON.stringify({ project: destination }),
    })
    const afterPush = await hydra.owner({
      args: [
        'task',
        'show',
        taskId,
        '--full',
      ],
    })
    expect(afterPush.task.asks.filter((ask: { closed?: unknown }) => !ask.closed)).toHaveLength(0)
    expect(afterPush.task.asks).toContainEqual(expect.objectContaining({
      id: pendingBeforePush[0].id,
      closed: expect.any(Object),
    }))
    expect(pushed.card.column).toBe(afterPush.task.column)
    expect(pushed.card.revision).toBe(afterPush.task.revision)
  },
)
