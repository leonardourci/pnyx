import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { wakeReasons } from '../../src/core/wake-reasons.ts'
import { taskReadiness } from '../../src/core/dependencies.ts'
import { hydraDigest } from '../../src/core/digest.ts'
import { boardReview } from '../../src/review/board.ts'
import { advanceQueues } from '../../src/queue/advance.ts'
import { startAgent } from '../../src/integrations/paseo/launch.ts'
import type { Connect } from '../../src/integrations/paseo/client.ts'
import { git, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'dependencies persist, reject invalid graphs, and leave independent tasks available in parallel',
  async () => {
    const s = await pnyx.scenario()
    const hydra = await s.chat({ text: 'Track prerequisite readiness.' })

    for (const key of [
      'first',
      'second',
      'dependent',
    ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
          '--folder',
          s.folder({ name: key }),
        ],
      })
    }

    await s.owner({
      args: [
        'task',
        'depend',
        'dependent',
        '--on',
        'first',
        '--on',
        'second',
        '--event-id',
        'deps',
      ],
    })
    const count = s.events().filter(event => event.type === 'task.dependencies').length
    await s.owner({
      args: [
        'task',
        'depend',
        'dependent',
        '--on',
        'first',
        '--on',
        'second',
        '--event-id',
        'deps',
      ],
    })
    assert.equal(
      s.events().filter(event => event.type === 'task.dependencies').length,
      count,
    )
    assert.deepEqual(
      s.task({ key: 'dependent' }).prerequisites,
      [
        s.task({ key: 'first' }).id,
        s.task({ key: 'second' }).id,
      ],
    )

    for (const args of [
      [
        'task',
        'depend',
        'first',
        '--on',
        'dependent',
      ],
      [
        'task',
        'depend',
        'first',
        '--on',
        'first',
      ],
    ]) {
      assert.equal(
        (await s.ownerRefusal({ args })).code,
        'DEPENDENCY_CYCLE',
      )
    }

    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'depend',
          'first',
          '--on',
          'missing',
        ],
      })).code,
      'NOT_FOUND',
    )
    const blocked = await s.ownerRefusal({
      args: [
        'task',
        'start',
        'dependent',
      ],
    })
    assert.equal(
      blocked.code,
      'TASK_NOT_READY',
    )
    assert.match(
      blocked.error!,
      /first.*second/,
    )
    assert.equal(
      s.task({ key: 'dependent' }).launch,
      undefined,
    )

    for (const key of [
      'first',
      'second',
    ]) {
      await s.owner({
        args: [
          'task',
          'start',
          key,
        ],
      })
    }

    assert.ok(s.task({ key: 'first' }).sessionIds?.length)
    assert.ok(s.task({ key: 'second' }).sessionIds?.length)
    const worker = s.as({ agent: await s.agent({ cwd: s.task({ key: 'first' }).folder! }) })
    assert.equal(
      (await worker.refusal({
        args: [
          'task',
          'undepend',
          'dependent',
          '--on',
          'first',
        ],
      })).code,
      'OWNER_ONLY',
    )

    const state = s.state()
    assert.match(
      hydraDigest({
        state,
        hydraId: s.hydraId,
        owner: {},
      }),
      /waiting: first.*second/,
    )
    assert.match(
      boardReview({
        state,
        now: Date.now(),
      }).block,
      /Prerequisite: waiting for first/,
    )
    await s.owner({
      args: [
        'task',
        'show',
        'dependent',
      ],
    })
    await until({
      what: 'Hydra to hear the named prerequisite',
      check: () => hydra.received.some(text => text.includes('prerequisite: waiting for first')),
    })

    rmSync(
      join(
        process.env.PNYX_HOME!,
        'hydras',
        s.hydraId,
        'snapshot.json',
      ),
      { force: true },
    )
    await pnyx.restart()
    assert.equal(
      taskReadiness({
        state: s.state(),
        card: s.task({ key: 'dependent' }),
      }).ready,
      false,
    )
    await s.owner({
      args: [
        'task',
        'undepend',
        'dependent',
        '--on',
        'first',
        '--on',
        'second',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'dependent',
      ],
    })
    assert.ok(s.task({ key: 'dependent' }).sessionIds?.length)
  },
)

test(
  'a report needs accepted investigation completion, and reopening or holding it reports running dependents',
  async () => {
    const s = await pnyx.scenario()
    const hydra = await s.chat({ text: 'Watch research and implementation.' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'research',
        '--title',
        'Research',
        '--kind',
        'investigation',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'build',
        '--title',
        'Implementation',
        '--folder',
        s.folder({ name: 'implementation' }),
      ],
    })
    await s.owner({
      args: [
        'task',
        'depend',
        'build',
        '--on',
        'research',
      ],
    })
    const report = join(
      s.folder({ name: 'reports' }),
      'findings.md',
    )
    writeFileSync(
      report,
      '# Findings\nUse the indexed lookup.',
    )
    await s.owner({
      args: [
        'task',
        'report',
        'research',
        '--file',
        report,
      ],
    })
    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'start',
          'build',
        ],
      })).code,
      'TASK_NOT_READY',
    )

    await s.owner({
      args: [
        'task',
        'report-review',
        'research',
        '--report',
        s.task({ key: 'research' }).report!.id,
        '--none',
      ],
    })

    for (const status of [
      'blocked',
      'paused',
      'needs_you',
    ]) {
      await s.owner({
        args: [
          'task',
          'status',
          'research',
          status,
          '--note',
          'Still investigating',
        ],
      })
      assert.equal(
        (await s.ownerRefusal({
          args: [
            'task',
            'start',
            'build',
          ],
        })).code,
        'TASK_NOT_READY',
      )
    }

    await s.owner({
      args: [
        'task',
        'status',
        'research',
        'done',
      ],
    })
    await s.owner({
      args: [
        'task',
        'hold',
        'research',
        '--reason',
        'Revisit findings',
      ],
    })
    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'start',
          'build',
        ],
      })).code,
      'TASK_NOT_READY',
    )
    await s.owner({
      args: [
        'task',
        'ask',
        'research',
        '--to',
        'owner',
        '--kind',
        'go',
        '--question',
        'Use these findings?',
        '--actor',
        'hydra',
        '--reason',
        'Need go',
      ],
    })
    const ask = s.task({ key: 'research' }).asks!.at(-1)!
    await s.owner({
      args: [
        'task',
        'answer',
        'research',
        ask.id,
        '--choice',
        'Go',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'research',
        'done',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'build',
      ],
    })
    const session = s.task({ key: 'build' }).sessionIds![0]
    await s.owner({
      args: [
        'task',
        'status',
        'research',
        'working',
        '--note',
        'A new case needs checking',
      ],
    })
    await until({
      what: 'running dependent warning',
      check: () => hydra.received.some(text => text.includes('worker already assigned, Hydra must review')),
    })
    assert.equal(
      s.task({ key: 'build' }).sessionIds![0],
      session,
    )
    assert.equal(
      s.task({ key: 'build' }).stoppedAt,
      undefined,
    )
    assert.ok(boardReview({
      state: s.state(),
      now: Date.now(),
    }).flags.some(flag => flag.task === s.task({ key: 'build' }).id && flag.kind === 'prerequisite unmet'))
    await s.owner({
      args: [
        'outcome',
        'research',
        'done',
        '--event-id',
        'research-complete',
      ],
    })
    await s.owner({
      args: [
        'outcome',
        'research',
        '--clear',
        '--event-id',
        'research-reopen',
      ],
    })
    const reopened = s.events().find(event => event.id === 'research-reopen')!
    assert.ok(wakeReasons({
      state: s.state(),
      events: [reopened],
    }).some(line => line.includes('worker already assigned, Hydra must review')))
    await s.owner({
      args: [
        'undo',
        'research-reopen',
      ],
    })
    assert.equal(
      taskReadiness({
        state: s.state(),
        card: s.task({ key: 'build' }),
      }).ready,
      true,
    )
    await s.owner({
      args: [
        'undo',
        'research-complete',
      ],
    })
    const undone = s.events().find(event => event.undoes === 'research-complete')!
    assert.equal(
      taskReadiness({
        state: s.state(),
        card: s.task({ key: 'build' }),
      }).ready,
      false,
    )
    assert.ok(wakeReasons({
      state: s.state(),
      events: [undone],
    }).some(line => line.includes('worker already assigned, Hydra must review')))
  },
)

test(
  'a build prerequisite waits for its linked pull request to merge',
  async () => {
    const s = await pnyx.scenario()
    const hydra = await s.chat({ text: 'Track landing readiness.' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'base',
        '--title',
        'API change',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'client',
        '--title',
        'Client',
        '--folder',
        s.folder({ name: 'client' }),
      ],
    })
    await s.owner({
      args: [
        'task',
        'depend',
        'client',
        '--on',
        'base',
      ],
    })
    const url = s.pullRequest({
      number: 1,
      checks: '1 passed, 0 failed, 1 total',
    })
    await s.owner({
      args: [
        'link',
        'base',
        '--url',
        url,
      ],
    })
    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'status',
          'base',
          'done',
        ],
      })).code,
      'NOT_LANDED',
    )
    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'start',
          'client',
        ],
      })).code,
      'TASK_NOT_READY',
    )
    s.pullRequest({
      number: 1,
      state: 'merged',
    })
    await until({
      what: 'accepted merge completion',
      check: () => s.task({ key: 'base' }).status?.state === 'done',
    })
    await until({
      what: 'ready dependency wake',
      check: () => hydra.received.some(text => text.includes('prerequisites cleared; ready for dispatch')),
    })

    await s.owner({
      args: [
        'task',
        'start',
        'client',
      ],
    })
    assert.ok(s.task({ key: 'client' }).sessionIds?.length)
  },
)

test(
  'a queued handoff rechecks multiple prerequisites after restart and dispatches exactly once',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({ name: 'queue-app' })

    for (const key of [
      'current',
      'next',
    ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
          '--project',
          project,
          '--brief',
          `Implement ${key}`,
        ],
      })
    }

    for (const key of [
      'gate-one',
      'gate-two',
    ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
        ],
      })
    }

    await s.owner({
      args: [
        'task',
        'start',
        'current',
      ],
    })
    const current = s.task({ key: 'current' })
    const folder = current.copy!.path
    await s.agent({ cwd: folder })
    await until({
      what: 'current worker idle',
      check: () => s.task({ key: 'current' }).sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'task',
        'depend',
        'next',
        '--on',
        'gate-one',
        '--on',
        'gate-two',
      ],
    })
    await s.owner({
      args: [
        'task',
        'queue',
        'next',
        '--behind',
        'current',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'current',
        'done',
      ],
    })
    await advanceQueues({ hydraId: s.hydraId })
    assert.ok(s.task({ key: 'next' }).queue)
    assert.equal(
      s.task({ key: 'next' }).sessionIds?.length ?? 0,
      0,
    )
    await s.owner({
      args: [
        'task',
        'status',
        'gate-one',
        'done',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'gate-one',
        'working',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'gate-two',
        'done',
      ],
    })
    await pnyx.restart()
    await advanceQueues({ hydraId: s.hydraId })
    assert.ok(s.task({ key: 'next' }).queue)
    assert.equal(
      s.task({ key: 'next' }).copy,
      undefined,
    )
    await s.owner({
      args: [
        'task',
        'status',
        'gate-one',
        'done',
      ],
    })
    await advanceQueues({
      hydraId: s.hydraId,
      active: () => !s.task({ key: 'next' }).sessionIds?.length,
    })
    const next = s.task({ key: 'next' })
    assert.equal(
      next.queue,
      undefined,
    )
    assert.equal(
      next.sessionIds?.[0],
      current.sessionIds?.[0],
    )
    assert.equal(
      next.copy?.path,
      folder,
    )
    assert.equal(
      s.events().filter(event => event.type === 'task.session' && event.data.after === next.id).length,
      1,
    )
    assert.equal(
      s.received({ cwd: folder }).filter(text => text.includes(`pnyx-worker task="${next.id}"`)).length,
      0,
    )
    await s.owner({
      args: [
        'task',
        'status',
        'gate-one',
        'working',
      ],
    })
    await pnyx.restart()
    await advanceQueues({ hydraId: s.hydraId })
    assert.equal(
      s.received({ cwd: folder }).filter(text => text.includes(`pnyx-worker task="${next.id}"`)).length,
      0,
    )
    await s.owner({
      args: [
        'task',
        'status',
        'gate-one',
        'done',
      ],
    })
    await Promise.all([
      advanceQueues({ hydraId: s.hydraId }),
      advanceQueues({ hydraId: s.hydraId }),
    ])
    assert.equal(
      s.events().filter(event => event.type === 'task.session' && event.data.after === next.id).length,
      1,
    )
    await until({
      what: 'one next brief',
      check: () => s.received({ cwd: folder }).filter(text => text.includes(`pnyx-worker task="${next.id}"`)).length === 1,
    })
  },
)

test(
  'an unanswered permission on a completed prerequisite blocks direct start and queue handoff',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({ name: 'permissions-app' })

    for (const key of [
      'current',
      'next',
    ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
          '--project',
          project,
          '--brief',
          `Implement ${key}`,
        ],
      })
    }

    const gateFolder = s.folder({ name: 'permission-gate' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'gate',
        '--title',
        'Acceptance',
        '--folder',
        gateFolder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'gate',
      ],
    })
    const gate = await s.agent({ cwd: gateFolder })
    await until({
      what: 'gate worker idle',
      check: () => s.task({ key: 'gate' }).sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'task',
        'status',
        'gate',
        'done',
      ],
    })
    const permission = gate.useTool!({
      tool: 'Bash',
      input: {
        command: 'git status',
        description: 'Check completion',
      },
    })
    const request = await until({
      what: 'pending gate permission',
      check: () => s.task({ key: 'gate' }).permissions?.find(request => request.status === 'pending'),
    })
    assert.equal(
      s.task({ key: 'gate' }).status?.state,
      'done',
    )
    assert.equal(
      s.task({ key: 'gate' }).hold,
      undefined,
    )
    await s.owner({
      args: [
        'task',
        'depend',
        'next',
        '--on',
        'gate',
      ],
    })
    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'start',
          'next',
        ],
      })).code,
      'TASK_NOT_READY',
    )
    await s.owner({
      args: [
        'task',
        'start',
        'current',
      ],
    })
    await until({
      what: 'current worker idle',
      check: () => s.task({ key: 'current' }).sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'task',
        'queue',
        'next',
        '--behind',
        'current',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'current',
        'done',
      ],
    })
    await advanceQueues({ hydraId: s.hydraId })
    assert.ok(s.task({ key: 'next' }).queue)
    assert.equal(
      s.task({ key: 'next' }).sessionIds?.length ?? 0,
      0,
    )
    assert.equal(
      s.task({ key: 'next' }).copy,
      undefined,
    )
    await s.owner({
      args: [
        'task',
        'permission',
        'gate',
        request.id,
        'allow',
      ],
    })
    assert.deepEqual(
      await permission,
      { behavior: 'allow' },
    )
    await advanceQueues({ hydraId: s.hydraId })
    await advanceQueues({ hydraId: s.hydraId })
    assert.equal(
      s.task({ key: 'next' }).queue,
      undefined,
    )
    assert.equal(
      s.events().filter(event => event.type === 'task.session' && event.data.after === s.task({ key: 'next' }).id).length,
      1,
    )
  },
)

test(
  'an investigation cannot dispatch its build while a prerequisite is reopened',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'investigator' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'base',
        '--title',
        'Base',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'base',
        'done',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'research',
        '--title',
        'Research',
        '--kind',
        'investigation',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'depend',
        'research',
        '--on',
        'base',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'research',
      ],
    })
    await s.agent({ cwd: folder })
    await until({
      what: 'research worker idle',
      check: () => s.task({ key: 'research' }).sessionActivity === 'finished',
    })
    const report = join(
      s.folder({ name: 'reports' }),
      'research.md',
    )
    writeFileSync(
      report,
      '# Findings\nThe schema needs an index.',
    )
    await s.owner({
      args: [
        'task',
        'report',
        'research',
        '--file',
        report,
      ],
    })
    await s.owner({
      args: [
        'task',
        'report-review',
        'research',
        '--report',
        s.task({ key: 'research' }).report!.id,
        '--none',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'research',
        'done',
      ],
    })
    const before = s.task({ key: 'research' })
    await s.owner({
      args: [
        'task',
        'status',
        'base',
        'working',
      ],
    })
    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'build',
          'research',
        ],
      })).code,
      'TASK_NOT_READY',
    )
    assert.equal(
      s.task({ key: 'research' }).kind,
      'investigation',
    )
    assert.equal(
      s.task({ key: 'research' }).status?.id,
      before.status?.id,
    )
    assert.equal(
      s.received({ cwd: folder }).filter(text => text.includes('Start the build')).length,
      0,
    )
  },
)

for (const stage of [
  'model lookup',
  'agent creation',
]) {
  test(
    `Paseo rechecks prerequisites after ${stage}`,
    async () => {
      const s = await pnyx.scenario()
      const folder = s.folder({ name: 'paseo-task' })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'base',
          '--title',
          'Base',
        ],
      })
      await s.owner({
        args: [
          'task',
          'status',
          'base',
          'done',
        ],
      })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'client',
          '--title',
          'Client',
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'depend',
          'client',
          '--on',
          'base',
        ],
      })
      let created = 0
      const reopen = () => s.owner({
        args: [
          'task',
          'status',
          'base',
          'working',
        ],
      })
      const fakeClient = {
        providers: {
          listModels: async () => {
            if (stage === 'model lookup') {
              await reopen()
            }

            return {
              models: [
                {
                  id: 'claude-default',
                  isDefault: true,
                },
              ],
            }
          },
        },
        agents: {
          create: async () => {
            created++

            if (stage === 'agent creation') {
              await reopen()
            }

            return { id: 'created-agent' }
          },
        },
        close: async () => undefined,
      }
      const connect: Connect = async () => fakeClient as unknown as Awaited<ReturnType<Connect>>
      await assert.rejects(
        startAgent({
          hydraId: s.hydraId,
          task: 'client',
          harness: 'claude',
          prompt: 'Build the client',
          folder,
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
          connect,
        }),
        (error: unknown) => error instanceof Error && error.message.includes('not ready'),
      )
      assert.equal(
        created,
        stage === 'agent creation' ? 1 : 0,
      )
      assert.equal(
        s.task({ key: 'client' }).sessionIds?.length ?? 0,
        0,
      )
      assert.equal(
        s.task({ key: 'client' }).status,
        undefined,
      )
    },
  )
}

test(
  'queue preparation rechecks a prerequisite reopened during landing proof and concurrent completions dispatch once',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({ name: 'queue-race' })

    for (const key of [
      'current',
      'next',
    ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
          '--project',
          project,
          '--brief',
          `Implement ${key}`,
        ],
      })
    }

    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'gate',
        '--title',
        'Gate',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'gate',
        'done',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'current',
      ],
    })
    const current = s.task({ key: 'current' })
    const folder = current.copy!.path
    await s.agent({ cwd: folder })
    await until({
      what: 'current worker idle',
      check: () => s.task({ key: 'current' }).sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'task',
        'depend',
        'next',
        '--on',
        'gate',
      ],
    })
    await s.owner({
      args: [
        'task',
        'queue',
        'next',
        '--behind',
        'current',
      ],
    })
    writeFileSync(
      join(
        folder,
        'change.txt',
      ),
      'Queue prerequisite race\n',
    )
    git({
      cwd: folder,
      args: [
        'add',
        'change.txt',
      ],
    })
    git({
      cwd: folder,
      args: [
        'commit',
        '-qm',
        'Implement current',
      ],
    })
    const head = git({
      cwd: folder,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    git({
      cwd: folder,
      args: [
        'push',
        '-q',
        'origin',
        'HEAD:feature',
      ],
    })
    const landing = s.folder({ name: 'landing' })
    git({
      cwd: landing,
      args: [
        'clone',
        '-q',
        `${project}.git`,
        '.',
      ],
    })
    git({
      cwd: landing,
      args: [
        'merge',
        '--squash',
        'origin/feature',
      ],
    })
    git({
      cwd: landing,
      args: [
        'commit',
        '-qm',
        'Land current as a squash',
      ],
    })
    git({
      cwd: landing,
      args: [
        'push',
        '-q',
        'origin',
        'main',
      ],
    })
    const merge = git({
      cwd: landing,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    const url = s.pullRequest({
      number: 9,
      state: 'merged',
    })
    await s.owner({
      args: [
        'link',
        'current',
        '--url',
        url,
      ],
    })
    await until({
      what: 'current accepted as complete',
      check: () => s.task({ key: 'current' }).status?.state === 'done',
    })
    let proofRead = false
    await advanceQueues({
      hydraId: s.hydraId,
      readLanding: async () => {
        proofRead = true
        await s.owner({
          args: [
            'task',
            'status',
            'gate',
            'working',
          ],
        })

        return {
          head,
          merge,
        }
      },
    })
    assert.equal(
      proofRead,
      true,
    )
    assert.ok(s.task({ key: 'next' }).queue)
    assert.equal(
      s.task({ key: 'next' }).sessionIds?.length ?? 0,
      0,
    )
    assert.equal(
      git({
        cwd: folder,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      head,
    )
    await s.owner({
      args: [
        'task',
        'status',
        'gate',
        'done',
      ],
    })
    const readLanding = async () => ({
      head,
      merge,
    })
    await Promise.all([
      advanceQueues({
        hydraId: s.hydraId,
        readLanding,
      }),
      advanceQueues({
        hydraId: s.hydraId,
        readLanding,
      }),
    ])
    const next = s.task({ key: 'next' })
    assert.equal(
      next.sessionIds?.[0],
      current.sessionIds?.[0],
    )
    assert.equal(
      next.queue,
      undefined,
    )
    assert.equal(
      s.events().filter(event => event.type === 'task.session' && event.data.after === next.id).length,
      1,
    )
    await until({
      what: 'one prepared brief',
      check: () => s.received({ cwd: folder }).filter(text => text.includes(`pnyx-worker task="${next.id}"`)).length === 1,
    })
  },
)
