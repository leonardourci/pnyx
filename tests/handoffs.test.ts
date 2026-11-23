import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { afterHandoffSync } from './setup/handoff-sync.ts'
import { startPnyx, until, type Pnyx } from './setup/pnyx.ts'
import { createProject } from './setup/projects.ts'
import { git } from './setup/upgrade.ts'
import { workerLine } from './setup/worker-log.ts'

const PAGE_COMMAND = join(
  import.meta.dirname,
  'setup',
  'fixtures',
  'page-command.mjs',
)
const RESTART_FLOW_TIMEOUT_MS = 120_000
const HANDOFF_QUEUE_DELAY_MS = 100
let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ queueDelay: HANDOFF_QUEUE_DELAY_MS })
})

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
    let child: ReturnType<typeof spawn> | undefined
    let hooksConfigured = false
    let ready = false
    let ended = false
    let errors = ''
    onTestFinished(async () => {
      try {
        if (child && !ended) {
          child.kill('SIGKILL')
          await until({
            what: 'child server exits',
            check: () => ended,
          })
        }
      } finally {
        try {
          if (hooksConfigured) {
            git({
              cwd: project,
              args: [
                'config',
                '--unset',
                'core.hooksPath',
              ],
            })
          }
        } finally {
          await pnyx.restart()
        }
      }
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
    hooksConfigured = true

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

    child = launch({ afterCommit: false })

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
    expect((await hydra.ownerRefused({
      args: [
        'reply',
        targetId,
        '--text',
        'Hold the dirty target',
      ],
    })).code).toBe('CONFLICT')
    const blockedTarget = (await hydra.owner({
      args: [
        'task',
        'show',
        targetId,
        '--full',
      ],
    })).task
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
    await pnyx.restart({ queueDelay: HANDOFF_QUEUE_DELAY_MS })
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
