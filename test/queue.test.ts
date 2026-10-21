import { pullRequestLanding } from '../src/integrations/github/pull-request.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { hydraCheck } from '../src/cli/workers.ts'
import { startTask } from '../src/cli/start.ts'
import { decidePush, decideSession, decideUndo, type Decision } from '../src/core/decide.ts'
import { hydraEvent, roleColumn } from '../src/core/hydra.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { taskFolder, settleDone } from '../src/copies/copies.ts'
import { project } from '../src/projects/cli.ts'
import { advanceQueues } from '../src/queue/advance.ts'
import { QUEUE_CONTEXT_BYTES, QUEUE_MAX_TASKS, QUEUE_STALL_MS, workerQueue } from '../src/queue/state.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

const git = ({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}) => execFileSync(
  'git',
  [
    '-C',
    cwd,
    ...args,
  ],
  {
    encoding: 'utf8',
    stdio: [
      'ignore',
      'pipe',
      'pipe',
    ],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  },
).trim()
const meta = () => ({
  at: new Date().toISOString(),
  actor: 'test',
})

async function lab({ t }: { t: TestContext }) {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-queue-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'home',
  )
  process.env.PNYX_SEMANTIC = 'off'
  process.env.CLAUDE_CONFIG_DIR = join(
    root,
    'claude',
  )
  const gh = join(
    root,
    'gh-axi-fixture',
  )
  writeFileSync(
    gh,
    `#!/bin/sh
printf 'pull_request:\\n  state: open\\n'
`,
    { mode: 0o755 },
  )
  process.env.PNYX_GH_AXI = gh
  const repo = join(
    root,
    'app',
  )
  const origin = join(
    root,
    'origin.git',
  )
  mkdirSync(repo)
  git({
    cwd: repo,
    args: [
      'init',
      '-q',
      '-b',
      'main',
    ],
  })
  writeFileSync(
    join(
      repo,
      'app.txt',
    ),
    'one\n',
  )
  git({
    cwd: repo,
    args: [
      'add',
      '.',
    ],
  })
  git({
    cwd: repo,
    args: [
      'commit',
      '-qm',
      'init',
    ],
  })
  git({
    cwd: root,
    args: [
      'clone',
      '-q',
      '--bare',
      repo,
      origin,
    ],
  })
  git({
    cwd: repo,
    args: [
      'remote',
      'add',
      'origin',
      origin,
    ],
  })
  git({
    cwd: repo,
    args: [
      'fetch',
      '-q',
      'origin',
    ],
  })
  git({
    cwd: repo,
    args: [
      'remote',
      'set-head',
      'origin',
      '--auto',
    ],
  })
  commands.hydra([
    'create',
    'lab',
  ])
  await project([
    'add',
    repo,
    '--hydra',
    'lab',
  ])
  const task = ({ args }: { args: string[] }) => commands.task([
    ...args,
    '--hydra',
    'lab',
  ])

  for (const key of [
    'one',
    'two',
    'three',
    'four',
  ]) {
    task({
      args: [
        'create',
        '--key',
        key,
        '--title',
        `Related ${key}`,
        '--brief',
        `Implement ${key}`,
        '--project',
        'app',
      ],
    })
  }

  const state = () => loadHydra({ hydraId: 'lab' }).state
  const card = ({ key }: { key: string }) => state().cards[state().keys[key]!]!
  const folder = taskFolder({
    hydraId: 'lab',
    task: 'one',
    meta: meta(),
  })!
  const apply = ({ decision }: { decision: Decision }) => withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      assert.ok('event' in decision)
      writer.append({ event: decision.event })
    },
  })
  const push = ({ input }: { input: object }) => apply({
    decision: decidePush({
      state: state(),
      key: 'one',
      input,
      meta: meta(),
    }),
  })
  push({
    input: {
      agent: {
        provider: 'claude-code',
        sessionId: 'worker',
        cwd: folder,
        host: 'pnyx',
        loginFolder: process.env.CLAUDE_CONFIG_DIR,
      },
      activity: 'finished',
    },
  })
  const queue = ({
    key,
    behind = 'claude-code:worker',
  }: {
    key: string
    behind?: string
  }) => task({
    args: [
      'queue',
      key,
      '--behind',
      behind,
    ],
  })
  const sdk = hydraSdk()
  const server = await startServer({
    hydraId: 'lab',
    query: sdk.query,
  })
  const servers = [server]
  t.after(async () => {
    for (const running of servers) {
      await running.close()
    }

    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  })

  const commit = ({ text = 'two\n' }: { text?: string } = {}) => {
    writeFileSync(
      join(
        folder,
        'app.txt',
      ),
      text,
    )
    git({
      cwd: folder,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: folder,
      args: [
        'commit',
        '-qm',
        'change',
      ],
    })
  }

  const land = () => {
    git({
      cwd: repo,
      args: [
        'merge',
        '-q',
        '--no-ff',
        card({ key: 'one' }).copy!.branch!,
        '-m',
        'land',
      ],
    })
    git({
      cwd: repo,
      args: [
        'push',
        '-q',
        'origin',
        'main',
      ],
    })
  }

  return {
    root,
    repo,
    origin,
    folder,
    state,
    card,
    task,
    queue,
    push,
    apply,
    sdk,
    server,
    servers,
    commit,
    land,
  }
}

async function until({ check }: { check(): boolean | Promise<boolean> }) {
  for (let i = 0; i < 300; i++) {
    if (await check()) {
      return
    }

    await new Promise(resolve => setTimeout(
      resolve,
      10,
    ))
  }

  assert.fail('queue did not settle')
}

test(
  'queue order, unqueue, revisions, idempotency, CLI visibility and replay',
  async t => {
    const f = await lab({ t })
    f.queue({ key: 'two' })
    f.queue({
      key: 'three',
      behind: 'one',
    })
    f.queue({
      key: 'four',
      behind: 'two',
    })
    const order = () => workerQueue({
      state: f.state(),
      session: 'claude-code:worker',
    }).map(c => c.key)
    assert.deepEqual(
      order(),
      [
        'two',
        'four',
        'three',
      ],
    )
    assert.equal(
      f.card({ key: 'two' }).column,
      roleColumn({
        columns: f.state().config!.columns,
        role: 'queued',
      }),
    )
    f.task({
      args: [
        'reorder',
        'three',
        '--behind',
        'two',
      ],
    })
    assert.deepEqual(
      order(),
      [
        'two',
        'three',
        'four',
      ],
    )
    assert.throws(
      () => f.task({
        args: [
          'unqueue',
          'two',
          '--if-revision',
          '0',
        ],
      }),
      /revision/,
    )
    f.task({
      args: [
        'unqueue',
        'two',
        '--event-id',
        'remove',
      ],
    })
    const seq = f.state().seq
    f.task({
      args: [
        'unqueue',
        'two',
        '--event-id',
        'remove',
      ],
    })
    assert.equal(
      f.state().seq,
      seq,
    )
    assert.deepEqual(
      order(),
      [
        'three',
        'four',
      ],
    )
    const shown = f.task({
      args: [
        'show',
        'three',
      ],
    })
    assert.match(
      JSON.stringify(shown),
      /"position":1/,
    )
    assert.match(
      JSON.stringify(f.task({
        args: [
          'show',
          'one',
        ],
      })),
      /Related three/,
    )
    const check = await hydraCheck({
      args: [
        'check',
        '--after',
        String(seq - 1),
        '--hydra',
        'lab',
      ],
    })
    assert.match(
      JSON.stringify(check.queues),
      /"position":1/,
    )
    const events = readEvents({ hydraId: 'lab' })
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events,
      }),
      f.state(),
    )
  },
)

test(
  'queue rejects self, occupied, cross-project, hidden tasks and manual starts or attachment',
  async t => {
    const f = await lab({ t })
    assert.throws(
      () => f.queue({
        key: 'two',
        behind: 'two',
      }),
      /itself/,
    )
    assert.throws(
      () => f.queue({ key: 'one' }),
      /unstarted/,
    )
    f.task({
      args: [
        'rename',
        'two',
        '--project',
        'elsewhere',
      ],
    })
    assert.throws(
      () => f.queue({ key: 'two' }),
      /project/,
    )
    f.task({
      args: [
        'rename',
        'two',
        '--project',
        f.repo,
      ],
    })
    f.task({
      args: [
        'hide',
        'two',
      ],
    })
    assert.throws(
      () => f.queue({ key: 'two' }),
      /visible/,
    )
    f.task({
      args: [
        'unhide',
        'two',
      ],
    })
    f.queue({ key: 'two' })
    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task: 'two',
        via: 'command',
        meta: meta(),
      }),
      /unqueue/,
    )
    assert.throws(
      () => decideSession({
        state: f.state(),
        ref: 'claude-code:worker',
        task: 'two',
        meta: meta(),
      }),
      /unqueue/,
    )
  },
)

test(
  'open PRs and working agents hold the queue; a merged PR advances once on a fetched fresh branch',
  async t => {
    const f = await lab({ t })
    await project([
      'memory',
      'set',
      '--project',
      'app',
      '--key',
      'preferences',
      '--text',
      'Keep pagination changes small',
      '--hydra',
      'lab',
    ])
    f.commit()
    f.queue({ key: 'two' })
    f.queue({
      key: 'three',
      behind: 'two',
    })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    commands.link([
      f.card({ key: 'one' }).id,
      '--url',
      'https://github.com/example/app/pull/1',
      '--state',
      'open',
      '--hydra',
      'lab',
    ])
    await advanceQueues({
      hydraId: 'lab',
      readPR: async () => 'open',
    })
    assert.equal(
      f.card({ key: 'two' }).agent,
      undefined,
    )
    assert.equal(
      f.sdk.calls.length,
      0,
    )
    f.land()
    const defaultTip = git({
      cwd: f.repo,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    f.push({ input: { activity: 'working' } })
    await advanceQueues({
      hydraId: 'lab',
      readPR: async () => 'merged',
    })
    assert.equal(
      f.card({ key: 'two' }).agent,
      undefined,
    )
    f.push({ input: { activity: 'finished' } })
    await advanceQueues({
      hydraId: 'lab',
      readPR: async () => 'merged',
    })
    await until({ check: () => f.sdk.calls[0]?.messages.length === 1 && f.card({ key: 'two' }).activity === 'finished' })
    assert.equal(
      f.card({ key: 'two' }).agent?.sessionId,
      'worker',
    )
    assert.deepEqual(
      f.card({ key: 'one' }).sessionIds,
      [],
    )
    assert.equal(
      f.card({ key: 'two' }).queue,
      undefined,
    )
    assert.equal(
      f.card({ key: 'three' }).queue?.session,
      'claude-code:worker',
    )
    assert.equal(
      f.card({ key: 'one' }).copy?.state,
      'removed',
    )
    assert.equal(
      f.card({ key: 'two' }).copy?.state,
      'active',
    )
    assert.equal(
      f.card({ key: 'two' }).folder,
      f.folder,
    )
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      defaultTip,
    )
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'branch',
          '--show-current',
        ],
      }),
      `pnyx/lab-${f.card({ key: 'two' }).id}`,
    )
    assert.match(
      f.sdk.calls[0]!.messages[0]!,
      /Implement two.*fresh branch/s,
    )
    assert.match(
      f.sdk.calls[0]!.messages[0]!,
      /Keep pagination changes small/,
    )
    assert.equal(
      f.sdk.calls[0]!.messages[0]!.split('Implement two').length - 1,
      1,
    )
    assert.equal(
      f.card({ key: 'two' }).column,
      roleColumn({
        columns: f.state().config!.columns,
        role: 'in_progress',
      }),
    )
    await advanceQueues({
      hydraId: 'lab',
      readPR: async () => 'merged',
    })
    assert.equal(
      f.sdk.calls[0]!.messages.length,
      1,
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events: readEvents({ hydraId: 'lab' }),
      }),
      f.state(),
    )
  },
)

test(
  'without a PR the queue waits until declared done work lands; Done cleanup retains the worker folder',
  async t => {
    const f = await lab({ t })
    f.commit()
    f.queue({ key: 'two' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    commands.move([
      f.card({ key: 'one' }).id,
      'done',
      '--actor',
      'web',
      '--hydra',
      'lab',
    ])
    assert.equal(
      settleDone({ hydraId: 'lab' }),
      0,
    )
    await advanceQueues({ hydraId: 'lab' })
    assert.ok(f.card({ key: 'two' }).queue)
    assert.ok(existsSync(f.folder))
    f.land()
    await advanceQueues({ hydraId: 'lab' })
    assert.equal(
      f.card({ key: 'two' }).agent?.sessionId,
      'worker',
    )
  },
)

test(
  'ended, detached and stalled workers release all queued tasks with a short handoff',
  async t => {
    for (const why of [
      'ended',
      'detached',
      'stalled',
    ]) {
      await t.test(
        why,
        async t => {
          const f = await lab({ t })
          f.queue({ key: 'two' })
          f.queue({ key: 'three' })

          if (why === 'detached') {
            f.task({
              args: [
                'detach',
                'one',
              ],
            })
          } else {
            f.push({ input: { activity: why === 'ended' ? 'ended' : 'working' } })
          }

          await advanceQueues({
            hydraId: 'lab',
            now: Date.now() + QUEUE_STALL_MS + 1000,
          })

          for (const key of [
            'two',
            'three',
          ]) {
            assert.equal(
              f.card({ key }).queue,
              undefined,
            )
            assert.equal(
              f.card({ key }).column,
              roleColumn({
                columns: f.state().config!.columns,
                role: 'queued',
              }),
            )
            assert.match(
              f.card({ key }).queueNote!,
              /fresh worker/,
            )
          }

          assert.equal(
            f.sdk.calls.length,
            0,
          )
        },
      )
    }
  },
)

test(
  'large transcripts release the queue and dirty folders are preserved',
  async t => {
    for (const why of [
      'context',
      'dirty',
    ]) {
      await t.test(
        why,
        async t => {
          const f = await lab({ t })
          f.queue({ key: 'two' })
          f.task({
            args: [
              'status',
              'one',
              'done',
            ],
          })

          if (why === 'context') {
            const transcript = join(
              f.root,
              'large.jsonl',
            )
            writeFileSync(
              transcript,
              '',
            )
            truncateSync(
              transcript,
              QUEUE_CONTEXT_BYTES,
            )
            f.push({
              input: {
                agent: {
                  ...f.card({ key: 'one' }).agent,
                  transcriptPath: transcript,
                },
              },
            })
          } else {
            writeFileSync(
              join(
                f.folder,
                'draft.txt',
              ),
              'keep me',
            )
          }

          await advanceQueues({ hydraId: 'lab' })
          assert.equal(
            f.card({ key: 'two' }).queue,
            undefined,
          )
          assert.match(
            f.card({ key: 'two' }).queueNote!,
            why === 'context' ? /transcript/ : /uncommitted/,
          )
          assert.equal(
            f.sdk.calls.length,
            0,
          )

          if (why === 'dirty') {
            assert.equal(
              readFileSync(
                join(
                  f.folder,
                  'draft.txt',
                ),
                'utf8',
              ),
              'keep me',
            )
          }
        },
      )
    }
  },
)

test(
  'a worker takes at most three tasks before the rest return to Queued',
  async t => {
    const f = await lab({ t })
    f.queue({ key: 'two' })
    f.queue({ key: 'three' })
    f.queue({ key: 'four' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    await until({
      check: async () => {
        await advanceQueues({ hydraId: 'lab' })

        return f.card({ key: 'two' }).activity === 'finished'
      },
    })
    f.task({
      args: [
        'status',
        'two',
        'done',
      ],
    })
    await until({
      check: async () => {
        await advanceQueues({ hydraId: 'lab' })

        return f.card({ key: 'three' }).activity === 'finished'
      },
    })
    f.task({
      args: [
        'status',
        'three',
        'done',
      ],
    })
    await advanceQueues({ hydraId: 'lab' })
    assert.equal(
      f.state().sessions?.['claude-code:worker']?.queueCompleted,
      QUEUE_MAX_TASKS - 1,
    )
    assert.equal(
      f.card({ key: 'four' }).queue,
      undefined,
    )
    assert.match(
      f.card({ key: 'four' }).queueNote!,
      /3-task limit/,
    )
  },
)

test(
  'a restart delivers a recorded handoff once when the server stopped before its brief was sent',
  async t => {
    const f = await lab({ t })
    await f.server.close()
    f.queue({ key: 'two' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    await advanceQueues({
      hydraId: 'lab',
      active: () => !f.card({ key: 'two' }).agent,
    })
    assert.equal(
      f.card({ key: 'two' }).agent?.sessionId,
      'worker',
    )
    assert.equal(
      f.sdk.calls.length,
      0,
    )
    const restarted = await startServer({
      hydraId: 'lab',
      query: f.sdk.query,
    })
    f.servers.push(restarted)
    await until({ check: () => f.sdk.calls[0]?.messages.length === 1 })
    await advanceQueues({ hydraId: 'lab' })
    assert.equal(
      f.sdk.calls[0]!.messages.length,
      1,
    )
  },
)

test(
  'unknown presence holds the queue without fetching or sending a brief',
  async t => {
    const f = await lab({ t })
    f.queue({ key: 'two' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    const branch = git({
      cwd: f.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })
    await advanceQueues({
      hydraId: 'lab',
      presence: async () => [
        {
          task: f.card({ key: 'one' }).id,
          session: 'claude-code:worker',
          harness: 'claude-code',
          folder: f.folder,
          via: 'pnyx',
          started: 'unknown',
          activity: 'finished',
          lastSeen: 'unknown',
          quiet: 'unknown',
          state: 'unknown',
          detail: 'unreachable',
        },
      ],
    })
    assert.ok(f.card({ key: 'two' }).queue)
    assert.equal(
      f.sdk.calls.length,
      0,
    )
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'branch',
          '--show-current',
        ],
      }),
      branch,
    )
  },
)

test(
  'a worker in a subdirectory of the primary checkout cannot switch its branch',
  async t => {
    const f = await lab({ t })
    const nested = join(
      f.repo,
      'nested',
    )
    mkdirSync(nested)
    f.push({
      input: {
        agent: {
          ...f.card({ key: 'one' }).agent,
          cwd: nested,
        },
      },
    })
    f.queue({ key: 'two' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    await advanceQueues({ hydraId: 'lab' })
    assert.equal(
      f.card({ key: 'two' }).agent,
      undefined,
    )
    assert.equal(
      f.card({ key: 'two' }).queue,
      undefined,
    )
    assert.match(
      f.card({ key: 'two' }).queueNote!,
      /isolated project folder/,
    )
    assert.equal(
      git({
        cwd: f.repo,
        args: [
          'branch',
          '--show-current',
        ],
      }),
      'main',
    )
  },
)

test(
  'a failed brief for the last queue entry is retried after the host returns',
  async t => {
    const f = await lab({ t })
    await f.server.close()
    f.queue({ key: 'two' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    assert.equal(
      await advanceQueues({ hydraId: 'lab' }),
      true,
    )
    assert.equal(
      f.card({ key: 'two' }).queue,
      undefined,
    )
    assert.equal(
      f.card({ key: 'two' }).replies?.at(-1)?.state,
      'failed',
    )
    const restarted = await startServer({
      hydraId: 'lab',
      query: f.sdk.query,
    })
    f.servers.push(restarted)
    await until({
      check: () => f.sdk.calls[0]?.messages.length === 1
      && f.card({ key: 'two' }).replies?.at(-1)?.state === 'delivered',
    })
    assert.equal(
      await advanceQueues({ hydraId: 'lab' }),
      false,
    )
    assert.equal(
      f.sdk.calls[0]!.messages.length,
      1,
    )
    assert.equal(
      f.card({ key: 'two' }).replies?.at(-1)?.state,
      'delivered',
    )
  },
)

test(
  'repeated insertion preserves exact order and replay after floating point precision would expire',
  async t => {
    const f = await lab({ t })

    for (const key of [
      'two',
      'three',
      'four',
    ]) {
      f.queue({ key })
    }

    for (let i = 0; i < 70; i++) {
      const key = i % 2 ? 'three' : 'four'
      f.task({
        args: [
          'reorder',
          key,
          '--behind',
          'two',
        ],
      })
      assert.deepEqual(
        workerQueue({
          state: f.state(),
          session: 'claude-code:worker',
        }).map(c => c.key),
        [
          'two',
          key,
          key === 'three' ? 'four' : 'three',
        ],
      )
    }

    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events: readEvents({ hydraId: 'lab' }),
      }),
      f.state(),
    )
  },
)

test(
  'automatic handoff cannot be undone after changing branch and copy ownership',
  async t => {
    const f = await lab({ t })
    f.queue({ key: 'two' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    await until({
      check: async () => {
        await advanceQueues({ hydraId: 'lab' })

        return Boolean(f.card({ key: 'two' }).agent)
      },
    })
    const event = readEvents({ hydraId: 'lab' }).find(e => e.type === 'task.session' && e.data.handoff)!
    const state = f.state()
    const before = structuredClone(state)
    const branch = git({
      cwd: f.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })
    assert.throws(
      () => decideUndo({
        state,
        target: event,
        meta: meta(),
      }),
      /cannot be undone/,
    )
    assert.deepEqual(
      state,
      before,
    )
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'branch',
          '--show-current',
        ],
      }),
      branch,
    )
  },
)

test(
  'a pull request merged outside the default branch cannot start dependent work',
  async t => {
    const f = await lab({ t })
    await f.server.close()
    f.commit()
    const head = git({
      cwd: f.folder,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    git({
      cwd: f.repo,
      args: [
        'switch',
        '-c',
        'release',
      ],
    })
    git({
      cwd: f.repo,
      args: [
        'merge',
        '--no-ff',
        f.card({ key: 'one' }).copy!.branch!,
        '-m',
        'release merge',
      ],
    })
    const merge = git({
      cwd: f.repo,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    git({
      cwd: f.repo,
      args: [
        'push',
        'origin',
        'release',
      ],
    })
    commands.link([
      'one',
      '--url',
      'https://github.com/example/app/pull/2',
      '--state',
      'merged',
      '--hydra',
      'lab',
    ])
    f.queue({ key: 'two' })
    await advanceQueues({
      hydraId: 'lab',
      readLanding: async () => ({
        head,
        merge,
      }),
    })
    assert.equal(
      f.card({ key: 'two' }).agent,
      undefined,
    )
    assert.equal(
      f.card({ key: 'two' }).queue,
      undefined,
    )
    assert.match(
      f.card({ key: 'two' }).queueNote!,
      /default branch/,
    )
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      head,
    )
  },
)

test(
  'squash merges are verified by merged commit ancestry on a freshly fetched default',
  async t => {
    const f = await lab({ t })
    await f.server.close()
    f.commit()
    const head = git({
      cwd: f.folder,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    const branch = f.card({ key: 'one' }).copy!.branch!
    git({
      cwd: f.folder,
      args: [
        'push',
        'origin',
        branch,
      ],
    })
    const merger = join(
      f.root,
      'merger',
    )
    git({
      cwd: f.root,
      args: [
        'clone',
        f.origin,
        merger,
      ],
    })
    git({
      cwd: merger,
      args: [
        'merge',
        '--squash',
        `origin/${branch}`,
      ],
    })
    git({
      cwd: merger,
      args: [
        'commit',
        '-m',
        'squash',
      ],
    })
    const merge = git({
      cwd: merger,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    git({
      cwd: merger,
      args: [
        'push',
        'origin',
        'main',
      ],
    })
    commands.link([
      'one',
      '--url',
      'https://github.com/example/app/pull/3',
      '--state',
      'merged',
      '--hydra',
      'lab',
    ])
    f.queue({ key: 'two' })
    await until({
      check: async () => {
        await advanceQueues({
          hydraId: 'lab',
          readLanding: async () => ({
            head,
            merge,
          }),
        })

        return Boolean(f.card({ key: 'two' }).agent)
      },
    })
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      merge,
    )
    assert.equal(
      readFileSync(
        join(
          f.folder,
          'app.txt',
        ),
        'utf8',
      ),
      'two\n',
    )
  },
)

test(
  'handoff discovers a changed default branch and fetches commits pushed from an independent clone',
  async t => {
    const f = await lab({ t })
    const merger = join(
      f.root,
      'merger',
    )
    git({
      cwd: f.root,
      args: [
        'clone',
        f.origin,
        merger,
      ],
    })
    git({
      cwd: merger,
      args: [
        'switch',
        '-c',
        'trunk',
      ],
    })
    writeFileSync(
      join(
        merger,
        'new-default.txt',
      ),
      'fresh remote work',
    )
    git({
      cwd: merger,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: merger,
      args: [
        'commit',
        '-m',
        'new default',
      ],
    })
    git({
      cwd: merger,
      args: [
        'push',
        'origin',
        'trunk',
      ],
    })
    git({
      cwd: f.origin,
      args: [
        'symbolic-ref',
        'HEAD',
        'refs/heads/trunk',
      ],
    })
    const tip = git({
      cwd: merger,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    f.queue({ key: 'two' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    await until({
      check: async () => {
        await advanceQueues({ hydraId: 'lab' })

        return Boolean(f.card({ key: 'two' }).agent)
      },
    })
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      tip,
    )
    assert.equal(
      f.card({ key: 'two' }).copy?.base,
      'trunk',
    )
    assert.equal(
      readFileSync(
        join(
          f.folder,
          'new-default.txt',
        ),
        'utf8',
      ),
      'fresh remote work',
    )
  },
)

test(
  'Firstmate owns assignments and automatic handoff leaves its existing queues untouched',
  async t => {
    const f = await lab({ t })
    await f.server.close()
    f.queue({ key: 'two' })
    f.apply({
      decision: hydraEvent({
        state: f.state(),
        cardId: '$board',
        meta: meta(),
        change: {
          type: 'board.configured',
          data: {
            ...f.state().config!,
            hydra: {
              ...f.state().config!.hydra,
              kind: 'firstmate',
              home: join(
                f.root,
                'fixture-firstmate',
              ),
            },
          },
        },
      }),
    })
    const before = f.state()
    assert.throws(
      () => f.queue({ key: 'three' }),
      /Firstmate owns/,
    )
    assert.equal(
      await advanceQueues({ hydraId: 'lab' }),
      false,
    )
    assert.deepEqual(
      f.state(),
      before,
    )
  },
)

test(
  'a second Hydra using the same native session through an alias prevents branch switching',
  async t => {
    const f = await lab({ t })
    const nested = join(
      f.folder,
      'nested',
    )
    mkdirSync(nested)
    const alias = join(
      f.root,
      'alias',
    )
    symlinkSync(
      nested,
      alias,
    )
    commands.hydra([
      'create',
      'other',
    ])
    commands.task([
      'create',
      '--key',
      'shared',
      '--title',
      'Shared folder',
      '--hydra',
      'other',
    ])
    withWriter({
      hydraId: 'other',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          key: 'shared',
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'worker',
              host: 'pnyx',
              cwd: alias,
            },
            activity: 'finished',
          },
          meta: meta(),
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const branch = git({
      cwd: f.folder,
      args: [
        'branch',
        '--show-current',
      ],
    })
    f.queue({ key: 'two' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    await advanceQueues({ hydraId: 'lab' })
    assert.match(
      f.card({ key: 'two' }).queueNote!,
      /Another worker/,
    )
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'branch',
          '--show-current',
        ],
      }),
      branch,
    )
  },
)

test(
  'uncertain handoff receipts are preserved without resending',
  async t => {
    const f = await lab({ t })
    await f.server.close()
    f.queue({ key: 'two' })
    f.task({
      args: [
        'status',
        'one',
        'done',
      ],
    })
    await advanceQueues({ hydraId: 'lab' })
    const card = f.card({ key: 'two' })
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'uncertain',
            ...meta(),
            cardId: card.id,
            type: 'card.replied',
            data: {
              reply: card.replies!.at(-1)!.id,
              state: 'delivery_unknown',
              route: 'pnyx',
            },
          },
        })
      },
    })
    assert.equal(
      await advanceQueues({ hydraId: 'lab' }),
      false,
    )
    assert.equal(
      f.card({ key: 'two' }).replies?.at(-1)?.state,
      'delivery_unknown',
    )
    assert.equal(
      f.sdk.calls.length,
      0,
    )
  },
)

test(
  'gh-axi PR landing metadata requires a merged result and both commit identifiers',
  async t => {
    const f = await lab({ t })
    const head = 'a'.repeat(40)
    const merge = 'b'.repeat(40)
    const fixture = ({ result }: { result: string }) => writeFileSync(
      join(
        f.root,
        'gh-axi-fixture',
      ),
      `#!/bin/sh\nprintf '%s\\n' 'api_response:' '  body: ${result}'\n`,
      { mode: 0o755 },
    )
    fixture({ result: `${head} ${merge} true` })
    assert.deepEqual(
      await pullRequestLanding({ url: 'https://github.com/example/app/pull/1' }),
      {
        head,
        merge,
      },
    )
    fixture({ result: `${head} ${merge} false` })
    assert.equal(
      await pullRequestLanding({ url: 'https://github.com/example/app/pull/1' }),
      undefined,
    )
  },
)
