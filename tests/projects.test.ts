import { discoverPullRequests } from '#tasks/delivery/discover.ts'
import { symlinkSync as linkCopyFolder, unlinkSync as unlinkCopyFolder } from 'node:fs'
import { withWriter } from '#app/writer.ts'
import { base } from '#app/command-meta.ts'
import * as processes from '#app/run-process.ts'
import { workerLine } from './setup/worker-log.ts'
import { afterHandoffSync } from './setup/handoff-sync.ts'
import { readEvents } from '#app/event-log.ts'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { parsed, operation, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'

const PAGE_COMMAND = join(
  import.meta.dirname,
  'setup',
  'fixtures',
  'page-command.mjs',
)
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
  pnyx = await startPnyx({ queueDelay: 100 })
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
  'Hydras share the home copy pool and keep another Hydra’s attached checkout reserved',
  async () => {
    const source = await pnyx.hydra()
    const target = await pnyx.hydra()
    const project = await createProject({
      hydra: source,
      landing: 'branch',
      name: 'shared-copy-pool',
    })
    await target.owner({
      args: [
        'project',
        'add',
        project,
        '--landing',
        'branch',
      ],
    })

    const starts = []

    for (const hydra of [
      source,
      target,
    ]) {
      const created = await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          'Use the shared pool',
          '--project',
          project,
        ],
      })
      starts.push(await hydra.owner({
        args: [
          'task',
          'start',
          created.card.id,
        ],
      }))
    }

    const first = starts[0]!.agent.folder as string
    const second = starts[1]!.agent.folder as string
    const pool = join(
      process.env.PNYX_HOME!,
      'copies',
    )
    expect(first.startsWith(`${pool}/`)).toBe(true)
    expect(second.startsWith(`${pool}/`)).toBe(true)
    expect(second).not.toBe(first)
    expect((await source.agent({ cwd: first })).closed).toBe(false)
    expect(git({
      cwd: first,
      args: [
        'branch',
        '--show-current',
      ],
    })).not.toBe(git({
      cwd: second,
      args: [
        'branch',
        '--show-current',
      ],
    }))

    await source.owner({
      args: [
        'task',
        'copy',
        starts[0]!.task,
        'remove',
        '--safe',
      ],
    })
    await source.owner({
      args: [
        'task',
        'detach',
        starts[0]!.task,
      ],
    })
    const firstTask = (await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'First concurrent checkout',
        '--project',
        project,
      ],
    })).card.id as string
    const secondTask = (await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Second concurrent checkout',
        '--project',
        project,
      ],
    })).card.id as string
    const bin = source.folder({ name: 'paused-git' })
    const entered = join(
      bin,
      'entered',
    )
    const release = join(
      bin,
      'release',
    )
    const previousPath = process.env.PATH
    const gitExecutable = spawnSync(
      'sh',
      [
        '-c',
        'command -v git',
      ],
      { encoding: 'utf8' },
    )
    expect(gitExecutable.status).toBe(0)
    writeFileSync(
      join(
        bin,
        'git',
      ),
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync } = require('node:fs')
const args = process.argv.slice(2)
;(async () => {
  if (args[0] === '-C' && args[1] === ${JSON.stringify(first)} && args[2] === 'status' && args.includes('--untracked-files=normal') && !existsSync(${JSON.stringify(entered)})) {
    mkdirSync(${JSON.stringify(entered)})
    const end = Date.now() + 20000
    while (!existsSync(${JSON.stringify(release)})) {
      if (Date.now() > end) throw new Error('checkout gate was never released')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const result = spawnSync(${JSON.stringify(gitExecutable.stdout.trim())}, args)
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  process.exitCode = result.status ?? 1
})().catch(error => { console.error(error); process.exitCode = 1 })
`,
      { mode: 0o755 },
    )
    process.env.PATH = `${bin}:${previousPath}`
    const pending = source.owner({
      args: [
        'task',
        'start',
        firstTask,
      ],
    })

    try {
      await until({
        what: 'the first reservation pauses inside Git before its checkout changes',
        check: () => existsSync(entered),
      })
      expect((await source.ownerRefused({
        args: [
          'task',
          'move',
          firstTask,
          '--to-hydra',
          target.id,
        ],
      })).code).toBe('CONFLICT')
      expect((await source.task({ key: firstTask })).id).toBe(firstTask)
      const competing = (await target.owner({
        args: [
          'task',
          'start',
          secondTask,
        ],
      })).agent.folder as string
      expect(competing).not.toBe(first)
      writeFileSync(
        join(
          competing,
          'competing-work.txt',
        ),
        'Keep the other worker’s saved work',
      )
      writeFileSync(
        release,
        '',
      )
      expect((await pending).agent.folder).toBe(first)
      expect(readFileSync(
        join(
          competing,
          'competing-work.txt',
        ),
        'utf8',
      )).toBe('Keep the other worker’s saved work')
      await source.owner({
        args: [
          'task',
          'move',
          firstTask,
          '--to-hydra',
          target.id,
        ],
      })
      expect((await target.owner({
        args: [
          'task',
          'show',
          firstTask,
          '--full',
        ],
      })).task.agent.cwd).toBe(first)
      await target.owner({
        args: [
          'task',
          'copy',
          firstTask,
          'remove',
          '--safe',
        ],
      })
      await target.owner({
        args: [
          'task',
          'detach',
          firstTask,
        ],
      })
      const legacy = join(
        process.env.PNYX_HOME!,
        'hydras',
        target.id,
        'copies',
        'retained-checkout',
      )
      mkdirSync(
        join(
          legacy,
          '..',
        ),
        { recursive: true },
      )
      git({
        cwd: project,
        args: [
          'worktree',
          'move',
          first,
          legacy,
        ],
      })
      const recordedPath = `${legacy}-recorded`
      linkCopyFolder(
        legacy,
        recordedPath,
        'dir',
      )
      await withWriter({
        hydraId: target.id,
        fn: ({ writer }) => {
          const card = writer.state.cards[firstTask]!
          writer.append({
            event: {
              ...base({
                state: writer.state,
                cardId: firstTask,
                meta: {
                  actor: 'fixture',
                  at: new Date().toISOString(),
                },
              }),
              type: 'task.copy',
              data: {
                before: card.copy!,
                after: {
                  ...card.copy!,
                  path: recordedPath,
                },
              },
            },
          })
        },
      })
      expect((await target.ownerRefused({
        args: [
          'task',
          'start',
          firstTask,
        ],
      })).code).toBe('COPY_FAILED')
      unlinkCopyFolder(recordedPath)
      git({
        cwd: project,
        args: [
          'worktree',
          'move',
          legacy,
          recordedPath,
        ],
      })
      expect((await target.owner({
        args: [
          'task',
          'start',
          firstTask,
        ],
      })).agent.folder).toBe(recordedPath)
    } finally {
      writeFileSync(
        release,
        '',
      )
      await Promise.allSettled([pending])
      process.env.PATH = previousPath
    }
  },
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
    const createdSource = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
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
      'copies',
    ))).toBe(true)
    await hydra.agent({ cwd: copy })
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
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'copy',
        'cart',
        'remove',
        '--discard',
      ],
    })).code).toBe('CONFLICT')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'copy',
        'cart',
        'remove',
        '--discard',
        '--actor',
        'worker:cart',
      ],
    })).code).toBe('CONFLICT')
    expect(readFileSync(
      join(
        copy,
        'cart.txt',
      ),
      'utf8',
    )).toBe('cart\n')
    expect((await hydra.owner({
      args: [
        'task',
        'copy',
        'cart',
      ],
    })).copy.state).toBe('active')

    await workerLine({
      hydra,
      key: 'cart',
      line: 'done: Cart implementation ready',
    })
    const workerDone = await hydra.owner({
      args: [
        'task',
        'show',
        'cart',
        '--full',
      ],
    })
    expect(workerDone.task.workerLog.status.code).toBe('done')
    expect(workerDone.task.doneAt).toBeUndefined()
    expect(workerDone.task.outcome?.closed).not.toBe(true)

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
        '--no-start',
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
        'create',
        '--no-start',
        '--title',
        'Handoff gate',
        '--key',
        'gate',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'depend',
        'next',
        '--on',
        'gate',
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
    await hydra.owner({
      args: [
        'outcome',
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
    PAGE_COMMAND,
    hydra.id,
    'task',
    'brief',
    'next',
    '--brief',
    'Updated chart brief',
  ])})
  writeFileSync(${JSON.stringify(hookMarker)}, 'declined')
}
if (branch === 'hercules/add-cart') {
  execFileSync(process.execPath, ${JSON.stringify([
    PAGE_COMMAND,
    hydra.id,
    'task',
    'depend',
    'next',
    '--on',
    'gate',
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
    await hydra.owner({
      args: [
        'task',
        'undepend',
        'next',
        '--on',
        'gate',
      ],
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
    const nextTask = await hydra.task({ key: 'next' })
    let lostReply = false
    const restoreSync = afterHandoffSync({
      home: process.env.PNYX_HOME!,
      hydra: hydra.id,
      source: createdSource.card.id,
      target: nextTask.id,
      cwd: copy,
      branch: 'hercules/next-chart-3',
      after: () => {
        lostReply = true
        throw new Error('lost acknowledgement after both native handoff logs synced')
      },
    })

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
      await hydra.owner({
        args: [
          'task',
          'undepend',
          'next',
          '--on',
          'gate',
        ],
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
      restoreSync()
    }

    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
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
    await hydra.agent({ cwd: copy })
    await hydra.owner({
      args: [
        'outcome',
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
        '--no-start',
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
        'outcome',
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
  'a create behind a worker on the same project queues it, a start that fails leaves it queued, a start takes it out of the queue for a worker of its own, once detached it is not shown as never started, and a replayed create or queue keeps its answer after the worker leaves',
  async () => {
    const hydra = await pnyx.hydra()
    await createProject({
      hydra,
      landing: 'branch',
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Lead',
        '--key',
        'lead',
        '--project',
        'shop',
      ],
    })
    const lead = await hydra.owner({
      args: [
        'task',
        'start',
        'lead',
      ],
    })
    await hydra.agent({ cwd: lead.agent.folder })
    expect(await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Follow',
        '--key',
        'follow',
        '--project',
        'shop',
        '--brief',
        'Follow the lead',
        '--behind',
        'lead',
      ],
    })).toMatchObject({ launch: 'queued' })

    const failedStarts = {
      NOT_FOUND: [
        '--rule',
        'no-such-rule',
      ],
    }

    for (const [
      code,
      flags,
    ] of Object.entries(failedStarts)) {
      expect(
        (await hydra.ownerRefused({
          args: [
            'task',
            'start',
            'follow',
            ...flags,
          ],
        })).code,
        flags.join(' '),
      ).toBe(code)
    }

    expect((await hydra.task({ key: 'follow' })).queue).toBeDefined()

    const started = await hydra.owner({
      args: [
        'task',
        'start',
        'follow',
      ],
    })
    expect(started.unqueued).toContain('was queued behind worker')
    expect((await hydra.task({ key: 'follow' })).queue).toBeUndefined()
    expect(started.agent.folder).not.toBe(lead.agent.folder)
    expect((await hydra.agent({ cwd: started.agent.folder })).received[0]).toContain('Follow the lead')

    await hydra.owner({
      args: [
        'task',
        'detach',
        'follow',
      ],
    })
    expect((await hydra.task({ key: 'follow' })).worker).toBe('none')

    const second = [
      'task',
      'create',
      '--title',
      'Follow again',
      '--project',
      'shop',
      '--behind',
      'lead',
      '--event-id',
      'follow-again',
    ]
    expect(await hydra.owner({ args: second })).toMatchObject({ launch: 'queued' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Wait for the lead',
        '--key',
        'wait',
        '--project',
        'shop',
      ],
    })
    const queueWait = [
      'task',
      'queue',
      'wait',
      '--behind',
      'lead',
      '--event-id',
      'queue-wait',
    ]
    await hydra.owner({
      args: [
        'task',
        'hide',
        'wait',
      ],
    })
    const hiddenQueue = await hydra.owner({
      args: [
        'task',
        'queue',
        'wait',
        '--behind',
        'lead',
      ],
    })
    expect(hiddenQueue.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('hidden task') }))
    expect((await hydra.task({ key: 'wait' })).queue).toBeDefined()
    await hydra.owner({
      args: [
        'task',
        'unqueue',
        'wait',
      ],
    })
    await hydra.owner({ args: queueWait })
    expect((await hydra.task({ key: 'wait' })).queue).toBeDefined()
    await hydra.owner({
      args: [
        'task',
        'detach',
        'lead',
      ],
    })
    const sessions = pnyx.claude.sessions.length
    expect(await hydra.owner({ args: second })).toMatchObject({ launch: 'queued' })
    expect(pnyx.claude.sessions).toHaveLength(sessions)
    const replayedQueue = await hydra.owner({ args: queueWait })
    expect(replayedQueue.queued).toBeUndefined()
    expect(replayedQueue.duplicate).toBeDefined()
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
    // Merges wake only a Hydra that Pnyx runs.
    await hydra.chat({ text: 'Watch the shop' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Write the cart notes',
        '--key',
        'notes',
        '--project',
        'shop',
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
        '--no-start',
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
    const cart = await hydra.owner({
      args: [
        'task',
        'show',
        'cart',
        '--full',
      ],
    })
    expect(cart.task.doneAt).toBeUndefined()
    expect(cart.task.outcome?.closed).not.toBe(true)
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

        return task.status === 'PR merged' && task
      },
    })
    expect(done.status).toBe('PR merged')
    expect(done.column).toBe(await hydra.column({ role: 'done' }))
    expect(merges({ number: 7 })).toBe(0)

    const reviewed = await until({
      what: 'the second merge to finish its task',
      check: async () => {
        const { task } = await hydra.owner({
          args: [
            'task',
            'show',
            'notes',
          ],
        })

        return task.status === 'PR merged' && task
      },
    })
    expect(reviewed.status).toBe('PR merged')
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
  'Hydra submits a merge despite owner defaults, Hold and red checks, shows the facts, and submits once after restart',
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
        '--no-start',
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
    publish({
      checks: '0 passed, 1 failed, 1 total',
      mergeBehavior: 'queued',
    })
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
    publish({
      checks: '0 passed, 1 failed, 1 total',
      mergeBehavior: 'rejected',
    })
    expect((await asHydra.refused({
      args: [
        ...merge,
        '--event-id',
        'rejected-merge',
      ],
    })).code).toBe('MERGE_FAILED')
    const rejected = await hydra.owner({
      args: [
        'task',
        'show',
        'gate',
        '--full',
      ],
    })
    const rejectedLink = rejected.task.links.find((entry: { url: string }) => entry.url === url)
    expect(rejectedLink.mergeAttempt ?? null).toBeNull()
    publish({
      checks: '0 passed, 1 failed, 1 total',
      mergeBehavior: 'queued',
    })
    const submitted = await asHydra.run({
      args: [
        ...merge,
        '--event-id',
        'corrected-merge',
      ],
    })
    const notices = submitted.notices.map((notice: { reason: string }) => notice.reason).join('\n')
    expect(notices).toContain('owner')
    expect(notices).toContain('red')
    expect([
      'queued',
      'unknown',
    ]).toContain(submitted.merge)
    expect(merges({ number: 21 })).toBe(2)

    await pnyx.restart()
    await asHydra.run({ args: merge })
    expect(merges({ number: 21 })).toBe(2)
  },
)

test(
  'Hydra submits private-repository merges with unreadable or failing evidence and records each gap',
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
        '--no-start',
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
    const session = await hydra.chat({ text: 'Review the private repository pull request.' })
    const asHydra = hydra.as({ session })
    const merge = [
      'task',
      'merge',
      'private',
      '--url',
      url,
    ]
    const cases = [
      {
        evidence: {
          classic: null,
          check: {
            ...run,
            conclusion: 'failure',
          },
        },
        reason: 'check is not green',
      },
      {
        evidence: {
          error: 'error: HTTP 404: Not Found',
          classic: {},
        },
        reason: 'classic protection unreadable',
      },
      {
        evidence: {
          error: 'error: HTTP 403: Forbidden',
          classic: {},
        },
        reason: 'classic protection unreadable',
      },
      {
        evidence: {
          error: 'error: "Resource not found"\ncode: NOT_FOUND',
          classic: {},
        },
        reason: 'classic protection unreadable',
      },
      {
        evidence: {
          check: {
            ...run,
            status: 'in_progress',
            conclusion: '',
          },
        },
        reason: 'check still running',
      },
      {
        evidence: {
          check: {
            ...run,
            app: { id: 43 },
          },
        },
        reason: 'missing required check',
      },
      {
        evidence: { error: 'error: HTTP 500: server error' },
        reason: 'branch rules unreadable',
      },
      {
        evidence: {
          error: '',
          rules: {},
        },
        reason: 'branch rules unreadable',
      },
      {
        evidence: { classic: {} },
        reason: 'classic protection unreadable',
      },
    ]

    for (const sample of cases) {
      writeFileSync(
        join(
          folder,
          '22.json',
        ),
        JSON.stringify({
          state: 'open',
          head,
          checks: '1 passed, 0 failed, 1 total',
          mergeBehavior: 'queued',
        }),
      )
      publish(sample.evidence)
      await hydra.owner({
        args: [
          'link',
          'private',
          '--url',
          url,
          '--remove',
        ],
      })
      await hydra.owner({
        args: [
          'link',
          'private',
          '--url',
          url,
        ],
      })
      const result = await asHydra.run({ args: merge })
      expect(result.merge).toBe('queued')
      const reason = expect.stringContaining(sample.reason)
      const expectedNotice = expect.objectContaining({ reason })
      expect(result.notices).toEqual(expect.arrayContaining([expectedNotice]))
      expect((await hydra.task({ key: 'private' })).notices).toBeDefined()
    }

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
    publish({ classic: null })
    await hydra.owner({
      args: [
        'link',
        'private',
        '--url',
        url,
        '--remove',
      ],
    })
    await hydra.owner({
      args: [
        'link',
        'private',
        '--url',
        url,
      ],
    })
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
    expect(submissions).toHaveLength(10)
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
          '--no-start',
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
  'attaching a repository to another Hydra succeeds with its existing owner visible and keeps existing work',
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
        '--no-start',
        '--title',
        'Keep this work',
        '--project',
        path,
      ],
    })
    const attached = await other.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const expectedOwner = expect.objectContaining({ reason: expect.stringContaining(owner.id) })
    expect(attached.notices).toEqual(expect.arrayContaining([expectedOwner]))
    expect((await owner.task({ key: task.card.id })).title).toBe('Keep this work')
    expect((await other.owner({
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
  },
)

test(
  'a keeper choice moves open work atomically, reports its defaults and preserves dependencies within the moved group',
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
    await withWriter({
      hydraId: id,
      create: true,
      fn: ({ writer }) => {
        writer.append({
          event: {
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
          },
        })
      },
    })
    const legacy = await pnyx.hydra({
      id,
      create: false,
    })
    const task = await legacy.owner({
      args: [
        'task',
        'create',
        '--no-start',
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
    const setupRun = await operation({
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
        '--no-start',
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
        '--no-start',
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
    const prerequisites = (await owner.task({ key: dependent.card.id })).prerequisites
    expect(prerequisites).toContainEqual(expect.objectContaining({ id: task.card.id }))
    expect(kept.notices).toBeDefined()
    expect((await owner.task({ key: free.card.id })).title).toBe('Independent work')
    expect(readEvents({
      hydraId: owner.id,
      cardId: task.card.id,
      types: ['task.moved-in'],
    }))
      .toContainEqual(expect.objectContaining({
        data: expect.objectContaining({ from: legacy.id }),
      }))
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
    const departure = readEvents({
      hydraId: legacy.id,
      cardId: task.card.id,
    })
    expect(departure.filter(event => event.type === 'task.moved-out')).toHaveLength(1)
    expect(readEvents({
      hydraId: owner.id,
      cardId: task.card.id,
    }))
      .toContainEqual(expect.objectContaining({ type: 'task.created' }))
    const changed = await owner.owner({
      args: [
        'task',
        'rename',
        task.card.id,
        '--title',
        'Work after the move',
      ],
    })
    await pnyx.restart()
    const sourceHistory = readEvents({
      hydraId: legacy.id,
      cardId: task.card.id,
    })
    expect(sourceHistory.map(event => event.id)).toEqual(departure.map(event => event.id))
    expect(sourceHistory).not.toContainEqual(expect.objectContaining({ id: changed.event.id }))
    expect(readEvents({
      hydraId: owner.id,
      cardId: task.card.id,
    }))
      .toContainEqual(expect.objectContaining({ id: changed.event.id }))
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
          '--no-start',
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
        '--no-start',
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
        '--no-start',
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
        '--no-start',
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
        '--no-start',
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

test.each([
  {
    cut: 'both',
    first: 'source',
  },
  {
    cut: 'first',
    first: 'source',
  },
  {
    cut: 'first',
    first: 'target',
  },
] as const)(
  'a server killed mid-handoff gets the source checkout back before the commit and keeps the target after it, refusing work on both tasks while changed work blocks recovery ($cut, $first first)',
  async ({
    cut,
    first,
  }) => {
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
    const firstTask = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'First candidate',
        '--project',
        'shop',
      ],
    })
    const secondTask = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Second candidate',
        '--project',
        'shop',
      ],
    })
    const ordered = [
      firstTask.card.id as string,
      secondTask.card.id as string,
    ].sort()
    const sourceId = ordered[first === 'source' ? 0 : 1]!
    const targetId = ordered[first === 'source' ? 1 : 0]!
    await hydra.owner({
      args: [
        'task',
        'rename',
        sourceId,
        '--title',
        'Source',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'rename',
        targetId,
        '--title',
        'Target',
      ],
    })
    const syncProof = join(
      hydra.folder({ name: 'handoff-proof' }),
      'first-scope',
    )
    const started = await hydra.owner({
      args: [
        'task',
        'start',
        sourceId,
      ],
    })
    const cwd = started.agent.folder as string
    await hydra.agent({ cwd })
    await hydra.owner({
      args: [
        'task',
        'brief',
        targetId,
        '--brief',
        'Prepare target',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
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
        targetId,
        '--on',
        'gate',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'queue',
        targetId,
        '--behind',
        sourceId,
      ],
    })
    await hydra.owner({
      args: [
        'outcome',
        sourceId,
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
    PAGE_COMMAND,
    hydra.id,
    'task',
    'depend',
    targetId,
    '--on',
    'gate',
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
            PNYX_CRASH_SOURCE: sourceId,
            PNYX_CRASH_TARGET: targetId,
            PNYX_CRASH_SCOPE_CUT: cut,
            PNYX_CRASH_PROOF: syncProof,
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
    onTestFinished(async () => {
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
    })

    await until({
      what: 'scratch child server ready',
      check: childReady,
    })
    await hydra.owner({
      args: [
        'task',
        'undepend',
        targetId,
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
    await hydra.task({ key: sourceId })
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
        sourceId,
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
        targetId,
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
        sourceId,
        '--full',
      ],
    })).task
    const target = (await hydra.owner({
      args: [
        'task',
        'show',
        targetId,
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
        targetId,
        '--on',
        'gate',
      ],
    })
    await until({
      what: 'server killed after durable handoff commit',
      check: () => ended,
    })
    expect(readFileSync(
      syncProof,
      'utf8',
    )).toBe(first)
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
        targetId,
        '--full',
      ],
    })).task
    expect((await hydra.ownerRefused({
      args: [
        'reply',
        targetId,
        '--text',
        'Hold the dirty target',
      ],
    })).code).toBe('CONFLICT')
    expect(blockedTarget.replies ?? []).toEqual([])
    const pendingSession = blockedTarget.sessionIds?.[0] ?? source.sessionIds[0]
    expect(await hydra.ownerRefused({
      args: [
        'task',
        'attach',
        'gate',
        '--session',
        pendingSession,
      ],
    })).toMatchObject({
      code: 'CONFLICT',
      error: expect.stringContaining('unresolved handoff'),
    })
    const currentHolder = (await hydra.owner({
      args: [
        'task',
        'sessions',
        '--full',
      ],
    })).sessions
      .find((session: { id: string }) => session.id === pendingSession).taskId
    expect(await hydra.ownerRefused({
      args: [
        'task',
        'detach',
        currentHolder,
      ],
    }))
      .toMatchObject({
        code: 'CONFLICT',
        error: expect.stringContaining('unresolved handoff'),
      })
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
        targetId,
        '--full',
      ],
    })).task
    const committedSource = (await hydra.owner({
      args: [
        'task',
        'show',
        sourceId,
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
        '--no-start',
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
        targetId,
      ],
    })
    await hydra.owner({
      args: [
        'outcome',
        targetId,
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
        '--no-start',
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
  PAGE_COMMAND,
  hydra.id,
  'task',
  'project',
  'drift',
  '--project',
  'other',
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
        '--no-start',
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
        '--no-start',
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
        '--no-start',
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
        '--no-start',
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
        '--no-start',
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
        '--no-start',
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
        '--no-start',
        '--title',
        'Finished work',
        '--project',
        path,
      ],
    })
    const parent = created.card.id
    await source.owner({
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
        '--no-start',
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
    await source.owner({
      args: [
        'task',
        'depend',
        workChild.card.id,
        '--on',
        parent,
      ],
    })
    const moved = await source.owner({
      args: [
        'task',
        'move',
        parent,
        '--to-hydra',
        keeper.id,
      ],
    })
    expect(moved.notices).toBeDefined()
    expect((await source.task({ key: workChild.card.id })).parent).toBe('none')
    expect((await source.task({ key: workChild.card.id })).prerequisites).toEqual([])
    expect((await source.task({ key: workChild.card.id })).notices).toBeDefined()
    await keeper.owner({
      args: [
        'project',
        'keep',
        path,
      ],
    })
    expect((await keeper.task({ key: parent })).title).toBe('Finished work')
    expect((await source.owner({
      args: [
        'task',
        'sessions',
      ],
    })).sessions).toContainEqual(expect.objectContaining({
      id: 'claude:helper-session/helper',
      task: 'none',
    }))
    expect((await keeper.ownerRefused({
      args: [
        'task',
        'show',
        'helper-record',
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
    await keeper.owner({
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
    const movedTask = (await keeper.owner({
      args: [
        'task',
        'show',
        parent,
        '--full',
      ],
    })).task
    const stream = join(
      movedTask.workerLogDir,
      'worker.log',
    )
    mkdirSync(
      join(
        stream,
        '..',
      ),
      { recursive: true },
    )
    appendFileSync(
      stream,
      'note: Immediately before the move\n',
    )
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
    expect((await target.owner({
      args: [
        'task',
        'show',
        parent,
        '--full',
      ],
    })).task.workerLog.latest.text).toBe('Immediately before the move')
    appendFileSync(
      stream,
      'note: Written to the same stream after the move\n',
    )
    await until({
      what: 'the moved worker stream to keep following',
      check: async () => (await target.owner({
        args: [
          'task',
          'show',
          parent,
          '--full',
        ],
      })).task.workerLog?.latest.text === 'Written to the same stream after the move',
    })

    expect((await keeper.owner({
      args: [
        'task',
        'sessions',
      ],
    })).sessions).toContainEqual(expect.objectContaining({
      id: 'codex:second-session/second',
      task: 'none',
    }))
    expect((await target.ownerRefused({
      args: [
        'task',
        'show',
        'second-helper',
      ],
    })).code).toBe('NOT_FOUND')
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
        '--no-start',
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
        '--no-start',
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

test(
  'a task discovers pull requests from its branch and keeps worker links deduplicated',
  async () => {
    const hydra = await pnyx.hydra()
    const project = await createProject({
      hydra,
      landing: 'pr',
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'discovered',
        '--title',
        'Discover a branch PR',
        '--project',
        'shop',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'discovered',
      ],
    })
    const full = await hydra.owner({
      args: [
        'task',
        'show',
        'discovered',
        '--full',
      ],
    })
    const branch = full.task.copy.branch
    const originalOrigin = git({
      cwd: project,
      args: [
        'remote',
        'get-url',
        'origin',
      ],
    }).trim()
    git({
      cwd: project,
      args: [
        'remote',
        'set-url',
        'origin',
        'https://github.com/o/shop.git',
      ],
    })
    writeFileSync(
      join(
        github,
        'o',
        'shop',
        '901.json',
      ),
      JSON.stringify({
        branch,
        state: 'open',
        draft: true,
      }),
    )
    writeFileSync(
      join(
        github,
        'o',
        'shop',
        '902.json',
      ),
      JSON.stringify({
        branch: 'someone-else',
        state: 'open',
      }),
    )
    await hydra.owner({
      args: [
        'task',
        'refresh-links',
        'discovered',
      ],
    })
    await until({
      what: 'the branch pull request to be discovered',
      check: async () => {
        const shown = await hydra.owner({
          args: [
            'task',
            'show',
            'discovered',
            '--full',
          ],
        })

        return shown.task.links.some((link: {
          url: string
          state: string
        }) => link.url === 'https://github.com/o/shop/pull/901' && link.state === 'open')
      },
    })
    await workerLine({
      hydra,
      key: 'discovered',
      line: 'link: https://github.com/o/shop/pull/901 Branch review',
    })
    const linked = await hydra.owner({
      args: [
        'task',
        'show',
        'discovered',
        '--full',
      ],
    })
    expect(linked.task.links).toHaveLength(1)
    expect(linked.task.links[0].src).toBe('branch')
    await pnyx.restart({
      whileStopped: async () => {
        let active = true
        const callLog = join(
          github,
          'calls.jsonl',
        )
        const callsBefore = readFileSync(
          callLog,
          'utf8',
        )
        const nativeRun = processes.runProcess
        const spy = vi.spyOn(
          processes,
          'runProcess',
        ).mockImplementation(async ({
          command,
          args,
          ...options
        }) => {
          const result = await nativeRun({
            command,
            args,
            ...options,
          })

          if (command === 'git' && args.includes(full.task.copy.path)
            && args.includes('symbolic-ref')) {
            active = false
          }

          return result
        })

        try {
          await discoverPullRequests({
            hydraId: hydra.id,
            interval: 0,
            checked: new Map(),
            active: () => active,
          })
          expect(active).toBe(false)
          expect(readFileSync(
            callLog,
            'utf8',
          )).toBe(callsBefore)
        } finally {
          spy.mockRestore()
        }
      },
    })
    const gate = join(
      github,
      'discovery-gate.json',
    )
    writeFileSync(
      gate,
      JSON.stringify({ branch }),
    )

    try {
      await hydra.owner({
        args: [
          'task',
          'refresh-links',
          'discovered',
        ],
      })
      await until({
        what: 'branch discovery to be pending',
        check: () => existsSync(`${gate}.ready`),
      })
      writeFileSync(
        join(
          github,
          'o',
          'shop',
          '901.json',
        ),
        JSON.stringify({
          branch,
          state: 'open',
          draft: true,
          title: 'Updated while discovery is pending',
        }),
      )
      await hydra.owner({
        args: [
          'task',
          'refresh-links',
          'discovered',
        ],
      })
      await until({
        what: 'the known pull request to refresh while discovery waits',
        check: async () => (await hydra.owner({
          args: [
            'task',
            'show',
            'discovered',
            '--full',
          ],
        })).task.links[0]?.title === 'Updated while discovery is pending',
      })
      expect(existsSync(`${gate}.ready`)).toBe(true)
    } finally {
      unlinkSync(gate)
    }

    expect(linked.task.branches).toEqual([
      {
        repository: 'o/shop',
        branch,
      },
    ])
    await hydra.owner({
      args: [
        'link',
        'discovered',
        '--url',
        'https://github.com/o/shop/pull/900',
        '--state',
        'merged',
      ],
    })
    expect((await hydra.task({ key: 'discovered' })).status).toBe('PR open')
    const followup = `${branch}-followup`
    const malformed = join(
      github,
      'malformed-discovery',
    )
    writeFileSync(
      malformed,
      JSON.stringify({ branch }),
    )

    try {
      git({
        cwd: full.task.copy.path,
        args: [
          'checkout',
          '-q',
          '-b',
          followup,
        ],
      })
      writeFileSync(
        join(
          github,
          'o',
          'shop',
          '903.json',
        ),
        JSON.stringify({
          branch: followup,
          sourceOwner: 'contributor',
          state: 'open',
          draft: true,
        }),
      )

      await workerLine({
        hydra,
        key: 'discovered',
        line: 'note: Follow-up branch ready',
      })
      await until({
        what: 'the new branch pull request despite an unreadable response for the earlier branch',
        check: async () => existsSync(`${malformed}.read`) && (await hydra.owner({
          args: [
            'task',
            'show',
            'discovered',
            '--full',
          ],
        })).task.links.some((link: { url: string }) => link.url.endsWith('/903')),
      })
    } finally {
      unlinkSync(malformed)

      if (existsSync(`${malformed}.read`)) {
        unlinkSync(`${malformed}.read`)
      }
    }

    await pnyx.restart()
    const restored = await hydra.owner({
      args: [
        'task',
        'show',
        'discovered',
        '--full',
      ],
    })
    expect(restored.task.links.filter((link: { url: string }) => link.url.endsWith('/901'))).toHaveLength(1)
    expect(restored.task.branches).toEqual([
      {
        repository: 'o/shop',
        branch,
      },
      {
        repository: 'o/shop',
        branch: followup,
      },
    ])
    git({
      cwd: project,
      args: [
        'remote',
        'set-url',
        'origin',
        originalOrigin,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'copy',
        'discovered',
        'remove',
        '--safe',
      ],
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'discovered',
        '--full',
      ],
    })).task.copy.state)
      .toBe('removed')
    git({
      cwd: project,
      args: [
        'remote',
        'set-url',
        'origin',
        'https://github.com/o/shop.git',
      ],
    })
    const outside = join(
      process.env.TMPDIR!,
      `outside-copy-${hydra.id}`,
    )
    git({
      cwd: project,
      args: [
        'clone',
        '-q',
        '--local',
        project,
        outside,
      ],
    })
    const outsideBranch = 'outside-worker-branch'
    git({
      cwd: outside,
      args: [
        'checkout',
        '-q',
        '-b',
        outsideBranch,
      ],
    })
    git({
      cwd: outside,
      args: [
        'remote',
        'set-url',
        'origin',
        'https://github.com/o/shop.git',
      ],
    })
    writeFileSync(
      join(
        github,
        'o',
        'shop',
        '904.json',
      ),
      JSON.stringify({
        branch: outsideBranch,
        state: 'open',
        draft: true,
      }),
    )
    await hydra.owner({
      args: [
        'push',
        '--key',
        'outside-discovery',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude',
          sessionId: 'outside-discovery',
          cwd: outside,
        },
        terminal: { tty: '/dev/ttys99999' },
        activity: 'finished',
      }),
    })
    await hydra.owner({
      args: [
        'task',
        'detach',
        'discovered',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'attach',
        'discovered',
        '--session',
        'claude:outside-discovery',
      ],
    })
    await until({
      what: 'a PR from the new worker clone despite the removed copy record',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'discovered',
          '--full',
        ],
      }))
        .task.links.some((link: { url: string }) => link.url.endsWith('/904')),
    })
  },
)

test(
  'copy reuse skips an ordinary retained directory inside the source repository',
  async () => {
    const hydra = await pnyx.hydra()
    const project = await createProject({
      hydra,
      landing: 'branch',
      name: 'retained-directory',
    })
    const task = (await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Retained directory',
        '--project',
        project,
      ],
    })).card.id as string
    const first = (await hydra.owner({
      args: [
        'task',
        'start',
        task,
      ],
    })).agent.folder as string
    await hydra.owner({
      args: [
        'task',
        'copy',
        task,
        'remove',
        '--safe',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'detach',
        task,
      ],
    })
    const ordinary = join(
      project,
      'ignored-retained',
    )
    mkdirSync(ordinary)
    appendFileSync(
      join(
        project,
        '.git',
        'info',
        'exclude',
      ),
      '\nignored-retained/\n',
    )
    await withWriter({
      hydraId: hydra.id,
      fn: ({ writer }) => {
        const card = writer.state.cards[task]!
        writer.append({
          event: {
            ...base({
              state: writer.state,
              cardId: task,
              meta: {
                actor: 'fixture',
                at: new Date().toISOString(),
              },
            }),
            type: 'task.copy',
            data: {
              before: card.copy!,
              after: {
                ...card.copy!,
                path: ordinary,
              },
            },
          },
        })
      },
    })
    expect((await hydra.owner({
      args: [
        'task',
        'start',
        task,
      ],
    })).agent.folder).toBe(first)
    expect(git({
      cwd: project,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('main')
  },
)

test(
  'copy reuse protects a worker running in a released slot subdirectory',
  async () => {
    const source = await pnyx.hydra()
    const peer = await pnyx.hydra()
    const project = await createProject({
      hydra: source,
      landing: 'branch',
      name: 'nested-worker',
    })
    const task = (await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Released copy',
        '--project',
        project,
      ],
    })).card.id as string
    const first = (await source.owner({
      args: [
        'task',
        'start',
        task,
      ],
    })).agent.folder as string
    await source.owner({
      args: [
        'task',
        'copy',
        task,
        'remove',
        '--safe',
      ],
    })
    await source.owner({
      args: [
        'task',
        'detach',
        task,
      ],
    })
    appendFileSync(
      join(
        project,
        '.git',
        'info',
        'exclude',
      ),
      '\npackages/\n',
    )
    const nested = join(
      first,
      'packages',
      'app',
    )
    mkdirSync(
      nested,
      { recursive: true },
    )
    const other = (await peer.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Nested worker',
        '--folder',
        nested,
      ],
    })).card.id as string
    await peer.owner({
      args: [
        'task',
        'start',
        other,
      ],
    })
    const worker = await peer.agent({ cwd: nested })
    const next = (await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Another copy',
        '--project',
        project,
      ],
    })).card.id as string
    expect((await source.owner({
      args: [
        'task',
        'start',
        next,
      ],
    })).agent.folder).not.toBe(first)
    expect(worker.closed).toBe(false)
    expect((await peer.task({ key: other })).worker).toBe(`claude-code:${worker.id}`)
  },
)

test(
  'copy reuse refuses a linked active checkout before restarting its worker',
  async () => {
    const hydra = await pnyx.hydra()
    const project = await createProject({
      hydra,
      landing: 'branch',
      name: 'active-copy-link',
    })
    const task = (await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Active copy link',
        '--project',
        project,
      ],
    })).card.id as string
    const first = (await hydra.owner({
      args: [
        'task',
        'start',
        task,
      ],
    })).agent.folder as string
    await hydra.owner({
      args: [
        'task',
        'stop',
        task,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'detach',
        task,
      ],
    })
    const parked = join(
      hydra.folder({ name: 'parked-active-copy' }),
      'checkout',
    )
    git({
      cwd: project,
      args: [
        'worktree',
        'move',
        first,
        parked,
      ],
    })
    linkCopyFolder(
      parked,
      first,
      'dir',
    )

    try {
      expect((await hydra.ownerRefused({
        args: [
          'task',
          'start',
          task,
        ],
      })).code).toBe('CONFLICT')
    } finally {
      unlinkCopyFolder(first)
      git({
        cwd: project,
        args: [
          'worktree',
          'move',
          parked,
          first,
        ],
      })
    }
  },
)
