import { pullRequestLanding, pullRequestLandingSync } from '../src/integrations/github/pull-request.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { hydraCheck } from '../src/cli/workers.ts'
import { startTask } from '../src/cli/start.ts'
import { decidePush, decideSession, type Decision } from '../src/core/decide.ts'
import { roleColumn } from '../src/core/hydra.ts'
import { taskFolder } from '../src/copies/copies.ts'
import { project } from '../src/projects/cli.ts'
import { advanceQueues } from '../src/queue/advance.ts'
import { workerQueue } from '../src/queue/state.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { hostObserver } from './host-observer.ts'

const {
  startServer,
} = hostObserver({
  describe: () => loadHydra({ hydraId: 'lab' }).state,
})

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

test(
  'queue order, unqueue, revisions, idempotency and CLI visibility',
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
  'gh-axi PR landing metadata requires a merged result and both commit identifiers',
  async () => {
    const gh = join(
      mkdtempSync(join(
        tmpdir(),
        'pnyx-gh-',
      )),
      'gh-axi-fixture',
    )
    process.env.PNYX_GH_AXI = gh
    const head = 'a'.repeat(40)
    const merge = 'b'.repeat(40)

    const fixture = ({ merged }: { merged: boolean }) => {
      const body = JSON.stringify({
        head: {
          sha: head,
          ref: 'pnyx/task',
        },
        base: { ref: 'main' },
        merge_commit_sha: merged ? merge : null,
        merged,
        state: merged ? 'closed' : 'open',
        draft: false,
      })
      writeFileSync(
        gh,
        `#!/bin/sh\nprintf '%s\\n' 'payload: ${JSON.stringify(body)}'\n`,
        { mode: 0o755 },
      )
    }

    fixture({ merged: true })
    assert.deepEqual(
      await pullRequestLanding({ url: 'https://github.com/example/app/pull/1' }),
      {
        head,
        merge,
        branch: 'pnyx/task',
        base: 'main',
      },
    )
    assert.equal(
      pullRequestLandingSync({ url: 'https://github.com/example/app/pull/1' })?.branch,
      'pnyx/task',
    )
    fixture({ merged: false })
    assert.equal(
      await pullRequestLanding({ url: 'https://github.com/example/app/pull/1' }),
      undefined,
    )
    assert.equal(
      pullRequestLandingSync({ url: 'https://github.com/example/app/pull/1' }),
      undefined,
    )
  },
)

test(
  'a discussion hold stops an already queued task from taking the worker after landing',
  async t => {
    const f = await lab({ t })
    f.queue({ key: 'two' })
    await f.task({
      args: [
        'hold',
        'two',
        '--reason',
        'Discuss before building',
      ],
    })
    f.commit()
    f.land()
    await f.task({
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
          state: 'present',
          detail: 'fixture',
        },
      ],
    })
    assert.ok(f.card({ key: 'two' }).hold)
    assert.ok(f.card({ key: 'two' }).queue)
    assert.deepEqual(
      f.card({ key: 'two' }).sessionIds,
      [],
    )
    assert.equal(
      f.state().sessions!['claude-code:worker']!.taskId,
      f.card({ key: 'one' }).id,
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
  'a merged PR cannot hand a worker to its next task over a later local commit',
  async t => {
    const f = await lab({ t })
    await f.server.close()
    f.commit()
    const copy = f.card({ key: 'one' }).copy!
    const head = git({
      cwd: f.folder,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    git({
      cwd: f.folder,
      args: [
        'push',
        'origin',
        'HEAD:main',
      ],
    })
    git({
      cwd: f.repo,
      args: [
        'config',
        `url.${f.origin}.insteadOf`,
        'https://github.com/example/app.git',
      ],
    })
    git({
      cwd: f.repo,
      args: [
        'remote',
        'set-url',
        'origin',
        'https://github.com/example/app.git',
      ],
    })
    writeFileSync(
      join(
        f.folder,
        'local.txt',
      ),
      'keep the tail\n',
    )
    git({
      cwd: f.folder,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: f.folder,
      args: [
        'commit',
        '-qm',
        'tail after merged head',
      ],
    })
    const tail = git({
      cwd: f.folder,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    commands.link([
      'one',
      '--url',
      'https://github.com/example/app/pull/7',
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
        merge: head,
        branch: copy.branch,
        base: 'main',
      }),
    })
    assert.equal(
      f.card({ key: 'two' }).agent,
      undefined,
    )
    assert.match(
      f.card({ key: 'two' }).queueNote!,
      /outside the merged pull request/,
    )
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      tail,
    )
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'branch',
          '--show-current',
        ],
      }),
      copy.branch,
    )
    assert.equal(
      readFileSync(
        join(
          f.folder,
          'local.txt',
        ),
        'utf8',
      ),
      'keep the tail\n',
    )
  },
)

test(
  'unavailable merged-PR proof leaves a queued worker and all local work intact',
  async t => {
    const f = await lab({ t })
    await f.server.close()
    f.commit()
    const copy = f.card({ key: 'one' }).copy!
    const head = git({
      cwd: f.folder,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    const contents = readFileSync(
      join(
        f.folder,
        'app.txt',
      ),
      'utf8',
    )
    commands.link([
      'one',
      '--url',
      'https://github.com/example/app/pull/8',
      '--state',
      'merged',
      '--hydra',
      'lab',
    ])
    f.queue({ key: 'two' })
    await advanceQueues({
      hydraId: 'lab',
      readLanding: async () => undefined,
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
      /outside the merged pull request/,
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
    assert.equal(
      git({
        cwd: f.folder,
        args: [
          'branch',
          '--show-current',
        ],
      }),
      copy.branch,
    )
    assert.equal(
      readFileSync(
        join(
          f.folder,
          'app.txt',
        ),
        'utf8',
      ),
      contents,
    )
  },
)
