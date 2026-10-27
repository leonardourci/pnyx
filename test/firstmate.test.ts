// Firstmate integration against a fixture home copied into a temp dir, with a fake
// fm-send. Never points at a real Firstmate home.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadHydra, spoolWrite } from '../src/store/hydra-store.ts'
import { readEvents } from '../src/app/event-log.ts'
import { homeKey, resolveHome } from '../src/integrations/firstmate/home.ts'
import { latestActivity, openDecisions, parseStatusLine, statusNotes } from '../src/integrations/firstmate/status.ts'
import { syncHome, watchHome, type SyncResult } from '../src/integrations/firstmate/sync.ts'
import { roleColumn } from '../src/core/hydra.ts'
import { stopAll, track } from '../src/test-harness/processes.ts'
import { startServer } from '../src/server/server.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const FIXTURE = join(
  import.meta.dirname,
  'fixtures',
  'firstmate-home',
)
const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)

const columnId = ({ role }: { role: 'queued' | 'in_progress' | 'needs_you' | 'parked' | 'done' }) =>
  roleColumn({
    columns: loadHydra({ hydraId: 'default' }).state.config!.columns,
    role,
  })

function copyFixture(): {
  home: string
  env: NodeJS.ProcessEnv
} {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-fm-',
  ))
  cpSync(
    FIXTURE,
    join(
      root,
      'home',
    ),
    { recursive: true },
  )
  const env = {
    ...process.env,
    PNYX_HOME: join(
      root,
      'pnyx',
    ),
  }
  process.env.PNYX_HOME = env.PNYX_HOME

  return {
    home: resolveHome({
      path: join(
        root,
        'home',
      ),
    }),
    env,
  }
}

const cardOf = ({
  home,
  task,
}: {
  home: string
  task?: string
}) => {
  const { state } = loadHydra({ hydraId: 'default' })

  return state.cards[state.keys[task ? `${homeKey({ home })}:${task}` : homeKey({ home })]!]!
}

test(
  "status lines follow Firstmate's key grammar, ignore header timestamps and keep note text",
  () => {
    assert.deepEqual(
      parseStatusLine({ line: 'needs-decision [key=api] [at=1]: pick one' }),
      {
        verb: 'needs-decision',
        note: 'pick one',
        key: 'api',
        declares: true,
        colon: true,
      },
    )
    assert.deepEqual(
      [
        parseStatusLine({ line: 'resolved: [key=api] REST' }).key,
        parseStatusLine({ line: 'resolved: [key=api] REST' }).note,
      ],
      [
        'api',
        'REST',
      ],
    )
    assert.equal(
      parseStatusLine({ line: 'needs-decision: plain' }).key,
      'default',
    )
    assert.equal(
      parseStatusLine({ line: 'needs-decision [key=a b]: x' }).key,
      null,
    )
    assert.equal(
      parseStatusLine({ line: 'resolved corr=0123456789abcdef [key=k]: ok' }).verb,
      'resolved',
    )
    assert.equal(
      parseStatusLine({ line: 'just prose' }).declares,
      false,
    )

    // Header timestamps are dropped; the note keeps its own text.
    for (const line of [
      'blocked [at=10:30] [key=api] [at=<epoch>]: [at=11:00] waiting: retry later',
      'blocked\t[at=10:30] [at=11:00] [key=api]: [at=11:00] waiting: retry later',
      'blocked [key=api]: [at=11:00] waiting: retry later',
    ]) {
      assert.deepEqual(
        parseStatusLine({ line }),
        {
          verb: 'blocked',
          note: '[at=11:00] waiting: retry later',
          key: 'api',
          declares: true,
          colon: true,
        },
      )
    }

    assert.equal(
      parseStatusLine({ line: 'resolved: [key=api] [key=later] keep this' }).note,
      '[key=later] keep this',
    )
    assert.equal(
      parseStatusLine({ line: 'resolved corr=invalid [key=api]: keep this' }).verb,
      'resolved corr=invalid',
    )
  },
)

test(
  'the decision fold opens, closes and clears keys like Firstmate',
  () => {
    const log = [
      'needs-decision [key=a]: first',
      'blocked [key=b]: second',
      'working: unrelated progress',
      'resolved [key=a]: answered',
      "needs-decision [key=pending-reply-x]: not in the owner's vocabulary",
      'needs-decision [key=pending-reply-y]: pending-reply-missed: owner wrote this',
      'needs-decision: keyless uses default',
    ].join('\n')
    assert.deepEqual(
      openDecisions({
        log,
        kind: 'ship',
      }).map(d => d.key),
      [
        'b',
        'pending-reply-y',
        'default',
      ],
    )
    assert.deepEqual(
      openDecisions({
        log: `${log}\ndone: shipped`,
        kind: 'ship',
      }),
      [],
    )
    assert.equal(
      openDecisions({
        log: `${log}\ndone: other work`,
        kind: 'secondmate',
      }).length,
      3,
    )
    assert.deepEqual(
      openDecisions({
        log: 'needs-decision [key=k]: x\ncaptain-held [key=k]: moved to captain',
        kind: 'ship',
      }),
      [],
    )
    assert.equal(
      latestActivity({ log: 'working: a\ncontinuation prose\n' }),
      'working: a',
    )
  },
)

test(
  'decisions, answers and reports in a status log become notes',
  () => {
    const log = [
      'working [at=1791900000]: setup done',
      'needs-decision [key=api] [at=1791900100]: REST or RPC?',
      'resolved [key=api] [at=1791900200]: REST, the captain said keep it boring',
      'needs-decision: which docs first?',
      'done [at=1791900300]: PR https://github.com/example/app/pull/41 checks green',
      'done:',
      'needs-decision [key=bad slug]: malformed keys move nothing',
    ].join('\n')
    assert.deepEqual(
      statusNotes({ log }).map(({
        kind,
        text,
        at,
      }) => ({
        kind,
        text,
        at,
      })),
      [
        {
          kind: 'decision',
          text: 'needs-decision [api]: REST or RPC?',
          at: '2026-10-13T14:01:40.000Z',
        },
        {
          kind: 'decision',
          text: 'resolved [api]: REST, the captain said keep it boring',
          at: '2026-10-13T14:03:20.000Z',
        },
        {
          kind: 'decision',
          text: 'needs-decision: which docs first?',
          at: undefined,
        },
        {
          kind: 'summary',
          text: 'done: PR https://github.com/example/app/pull/41 checks green',
          at: '2026-10-13T14:05:00.000Z',
        },
      ],
    )
  },
)

test(
  'sync mirrors Firstmate tasks under its Hydra',
  () => {
    const { home } = copyFixture()
    const result = syncHome({
      hydraId: 'default',
      home,
      at: '2026-10-13T10:00:00.000Z',
    })
    assert.equal(
      result.tasks,
      5,
    )

    const parent = cardOf({ home })
    const api = cardOf({
      home,
      task: 'api-v2',
    })
    assert.equal(
      api.title,
      'v2 API with (optional) pagination',
    )
    assert.equal(
      api.project,
      'app',
    )
    assert.equal(
      parent.hidden,
      true,
    )
    assert.deepEqual(
      api.attention.map(a => [
        a.kind,
        a.key,
        a.blocking,
      ]),
      [
        [
          'needs-decision',
          'api-shape',
          true,
        ],
        [
          'blocked',
          'ci-token',
          true,
        ],
      ],
    )
    assert.equal(
      api.column,
      columnId({ role: 'needs_you' }),
      'an open decision needs the owner',
    )
    assert.equal(
      api.activity,
      'working: PR https://github.com/example/app/pull/41 opened',
    )
    assert.deepEqual(
      api.sourceRefs,
      [
        {
          adapter: 'firstmate',
          instanceId: home,
          objectId: 'api-v2',
        },
      ],
    )

    const scout = cardOf({
      home,
      task: 'docs-scout',
    })
    assert.equal(
      scout.project,
      'docs',
      'a repo tag names the project',
    )
    assert.deepEqual(
      scout.outcome,
      {
        state: 'done',
        source: 'firstmate',
      },
    )
    assert.equal(
      scout.column,
      columnId({ role: 'done' }),
    )
    const hotfix = cardOf({
      home,
      task: 'hotfix-2',
    })
    assert.deepEqual(
      hotfix.attention,
      [
        {
          kind: 'failed',
          key: '@status',
          blocking: true,
          text: 'tests red after patch',
        },
      ],
    )
    assert.equal(
      hotfix.outcome,
      undefined,
    )
    assert.equal(
      hotfix.column,
      columnId({ role: 'needs_you' }),
      'a failed latest line needs the owner',
    )
    const release = cardOf({
      home,
      task: 'release-1',
    })
    assert.deepEqual(
      release.links.map(l => [
        l.number,
        l.state,
      ]),
      [
        [
          40,
          'merged',
        ],
      ],
    )
    assert.equal(
      release.column,
      columnId({ role: 'done' }),
    )
    assert.equal(
      cardOf({
        home,
        task: 'later-1',
      }).column,
      columnId({ role: 'queued' }),
    )
    const moves = readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.moved')
    assert.equal(
      moves.find(e => e.cardId === api.id)?.reason,
      'working: PR https://github.com/example/app/pull/41 opened',
      "a move carries Firstmate's status line",
    )
    assert.equal(
      moves.find(e => e.cardId === cardOf({
        home,
        task: 'later-1',
      }).id)?.reason,
      'Queued in the Firstmate backlog',
    )

    assert.deepEqual(
      syncHome({
        hydraId: 'default',
        home,
      }),
      {
        tasks: 5,
        appended: 0,
      },
    )
  },
)

test(
  'the mirror keeps its last status and metadata once Firstmate removes them, and stops after an identity switch',
  () => {
    const {
      home,
      env,
    } = copyFixture()
    const sync = () => syncHome({
      hydraId: 'default',
      home,
    })
    const status = join(
      home,
      'state/api-v2.status',
    )
    sync()
    appendFileSync(
      status,
      'paused [at=1792000000]: Waiting for release\n',
    )
    sync()
    rmSync(status)
    rmSync(join(
      home,
      'state/api-v2.meta',
    ))
    sync()
    const mirror = () => cardOf({
      home,
      task: 'api-v2',
    }).mirror!
    assert.match(
      mirror().status,
      /Waiting for release/,
    )
    assert.ok(mirror().meta.worktree)

    cli({ env }).run({
      args: [
        'hydra',
        'set',
        '--identity',
        'next-agent',
      ],
    })
    appendFileSync(
      status,
      'working: changed after switch\n',
    )
    sync()
    assert.match(
      mirror().status,
      /Waiting for release/,
    )
  },
)

test(
  'a session Hydra keeps its Firstmate home, and another home is named when ignored',
  () => {
    const {
      home,
      env,
    } = copyFixture()
    syncHome({
      hydraId: 'default',
      home,
    })
    const { run } = cli({ env })
    const input = join(
      home,
      '..',
      'hydra.json',
    )
    writeFileSync(
      input,
      JSON.stringify({
        agent: {
          provider: 'claude-code',
          sessionId: 'fm-hydra',
        },
        terminal: {
          tty: '/dev/ttys126',
          pid: '126',
        },
      }),
    )
    run({
      args: [
        'push',
        '--key',
        'fm-hydra',
        '--file',
        input,
      ],
    })
    run({
      args: [
        'hydra',
        'set',
        '--session',
        'claude-code:fm-hydra',
      ],
    })
    const hydra = loadHydra({ hydraId: 'default' }).state.config!.hydra
    assert.equal(
      hydra.kind,
      'firstmate',
    )
    assert.equal(
      hydra.home,
      home,
    )
    assert.equal(
      hydra.session,
      'claude-code:fm-hydra',
    )
    assert.equal(
      syncHome({
        hydraId: 'default',
        home,
      }).ignored,
      undefined,
    )

    const other = join(
      home,
      '..',
      'other-home',
    )
    cpSync(
      FIXTURE,
      other,
      { recursive: true },
    )
    const out = run({
      args: [
        'firstmate',
        'sync',
        '--home',
        home,
        '--home',
        other,
      ],
    })
    assert.match(
      out,
      new RegExp(`Ignored ${resolveHome({ path: other })}`),
    )
    assert.match(
      out,
      new RegExp(
        `${home},5,0$`,
        'm',
      ),
    )
  },
)

// Moves a task's backlog row under a section, ticked when it lands in Done.
function moveRow({
  home,
  task,
  section,
}: {
  home: string
  task: string
  section: '## Done' | '## In flight'
}) {
  const backlog = join(
    home,
    'data',
    'backlog.md',
  )
  const rows = readFileSync(
    backlog,
    'utf8',
  ).split('\n')
  const [row] = rows.splice(
    rows.findIndex(l => l.replace(
      /^- \[[ x]\] /,
      '',
    ).startsWith(`${task} `)),
    1,
  )
  rows.splice(
    rows.indexOf(section) + 1,
    0,
    row!.replace(
      /^- \[[ x]\]/,
      section === '## Done' ? '- [x]' : '- [ ]',
    ),
  )
  writeFileSync(
    backlog,
    rows.join('\n'),
  )
}

function cli({ env }: { env: NodeJS.ProcessEnv }) {
  const run = ({ args }: { args: string[] }) => execFileSync(
    process.execPath,
    [
      BIN,
      ...args,
    ],
    {
      env,
      encoding: 'utf8',
    },
  )
  const fails = ({
    args,
    code,
  }: {
    args: string[]
    code: string
  }) =>
    assert.throws(
      () => run({ args: [...args] }),
      (error: { stdout: string }) => {
        assert.match(
          error.stdout,
          new RegExp(
            `^code: ${code}$`,
            'm',
          ),
        )

        return true
      },
    )

  return {
    run,
    fails,
  }
}

test(
  'a column edit before sync does not stand in for the Firstmate Hydra, and renamed default columns keep their role',
  () => {
    const {
      home,
      env,
    } = copyFixture()
    const { run } = cli({ env })
    run({
      args: [
        'column',
        'rename',
        'done',
        '--title',
        'Shipped',
      ],
    })
    run({
      args: [
        'column',
        'create',
        '--id',
        'custom:mine',
        '--title',
        'Mine',
      ],
    })
    assert.equal(
      syncHome({
        hydraId: 'default',
        home,
      }).tasks,
      5,
    )
    const config = loadHydra({ hydraId: 'default' }).state.config!
    assert.equal(
      config.hydra.home,
      home,
    )
    assert.deepEqual(
      config.columns.map(c => c.title),
      [
        'Queued',
        'In progress',
        'Needs you',
        'Parked',
        'Shipped',
        'Mine',
      ],
    )
    moveRow({
      home,
      task: 'hotfix-2',
      section: '## Done',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home,
        task: 'hotfix-2',
      }).column,
      columnId({ role: 'done' }),
      'moves follow the role, not the title',
    )
  },
)

test(
  'a task closed in the backlog clears its requests and moves to Done, recording a failure only when its last line failed',
  () => {
    for (const [
      status,
      outcome,
    ] of [
        [
          undefined,
          {
            state: 'failed',
            note: 'closed after failure',
            closed: true,
            source: 'firstmate',
          },
        ],
        [
          'working: reproducing\nblocked: waiting for CI token\n',
          {
            state: 'done',
            source: 'firstmate',
          },
        ],
      ] as const) {
      const { home } = copyFixture()

      if (status) {
        writeFileSync(
          join(
            home,
            'state',
            'hotfix-2.status',
          ),
          status,
        )
      }

      syncHome({
        hydraId: 'default',
        home,
      })
      moveRow({
        home,
        task: 'hotfix-2',
        section: '## Done',
      })
      syncHome({
        hydraId: 'default',
        home,
      })
      const hotfix = cardOf({
        home,
        task: 'hotfix-2',
      })
      assert.deepEqual(
        hotfix.attention,
        [],
      )
      assert.deepEqual(
        hotfix.outcome,
        outcome,
      )
      assert.equal(
        hotfix.column,
        columnId({ role: 'done' }),
      )
    }
  },
)

test(
  'a done declaration neither moves Hydra work nor closes its backlog record',
  () => {
    const { home } = copyFixture()
    moveRow({
      home,
      task: 'docs-scout',
      section: '## In flight',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    const scout = cardOf({
      home,
      task: 'docs-scout',
    })
    assert.equal(
      scout.outcome,
      undefined,
    )
    assert.equal(
      scout.status?.state,
      'done',
    )
    assert.equal(
      scout.column,
      columnId({ role: 'in_progress' }),
    )
  },
)

test(
  'an archived closure moves a mirrored task to Done after its worker records are removed',
  () => {
    const { home } = copyFixture()
    rmSync(join(
      home,
      'state',
      'api-v2.status',
    ))
    syncHome({
      hydraId: 'default',
      home,
    })
    const before = cardOf({
      home,
      task: 'api-v2',
    })
    assert.equal(
      before.column,
      columnId({ role: 'in_progress' }),
    )
    const backlog = join(
      home,
      'data',
      'backlog.md',
    )
    const rows = readFileSync(
      backlog,
      'utf8',
    ).split('\n')
    const [row] = rows.splice(
      rows.findIndex(line => line.startsWith('- [ ] api-v2')),
      1,
    )
    writeFileSync(
      backlog,
      rows.join('\n'),
    )
    rmSync(join(
      home,
      'state',
      'api-v2.meta',
    ))
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).column,
      before.column,
      'disappearance alone does not close a task',
    )
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).outcome,
      undefined,
    )

    writeFileSync(
      join(
        home,
        'data',
        'done-archive.md',
      ),
      `# Done archive\n\n## 2026-10\n${row!.replace(
        '[ ]',
        '[x]',
      )}\n- [x] ancient - unrelated archived task\n`,
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    const archived = cardOf({
      home,
      task: 'api-v2',
    })
    assert.equal(
      archived.title,
      before.title,
    )
    assert.deepEqual(
      archived.outcome,
      {
        state: 'done',
        source: 'firstmate',
      },
    )
    assert.equal(
      archived.column,
      columnId({ role: 'done' }),
    )
    assert.equal(
      readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.moved' && e.cardId === archived.id)
        .at(-1)?.reason,
      'Closed in Firstmate',
    )
    assert.equal(
      cardOf({
        home,
        task: 'ancient',
      }),
      undefined,
    )
    assert.equal(
      syncHome({
        hydraId: 'default',
        home,
      }).appended,
      0,
    )

    appendFileSync(
      backlog,
      `\n## In flight\n${row}\n`,
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).column,
      columnId({ role: 'in_progress' }),
    )
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).outcome,
      undefined,
    )
  },
)

test(
  'archiving a closed failure preserves its outcome after worker records are removed',
  () => {
    const { home } = copyFixture()
    moveRow({
      home,
      task: 'hotfix-2',
      section: '## Done',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    const before = cardOf({
      home,
      task: 'hotfix-2',
    })
    assert.equal(
      before.outcome?.state,
      'failed',
    )

    const backlog = join(
      home,
      'data',
      'backlog.md',
    )
    const rows = readFileSync(
      backlog,
      'utf8',
    ).split('\n')
    const [closed] = rows.splice(
      rows.findIndex(line => line.startsWith('- [x] hotfix-2')),
      1,
    )
    writeFileSync(
      backlog,
      rows.join('\n'),
    )
    writeFileSync(
      join(
        home,
        'data',
        'done-archive.md',
      ),
      `# Done archive\n${closed}\n`,
    )
    rmSync(join(
      home,
      'state',
      'hotfix-2.meta',
    ))
    rmSync(join(
      home,
      'state',
      'hotfix-2.status',
    ))
    syncHome({
      hydraId: 'default',
      home,
    })
    const archived = cardOf({
      home,
      task: 'hotfix-2',
    })
    assert.deepEqual(
      archived.outcome,
      before.outcome,
    )
    assert.equal(
      archived.column,
      columnId({ role: 'done' }),
    )
    assert.equal(
      syncHome({
        hydraId: 'default',
        home,
      }).appended,
      0,
    )
  },
)

test(
  'watch reconciles a closure added only to the done archive',
  async () => {
    const { home } = copyFixture()
    const backlog = join(
      home,
      'data',
      'backlog.md',
    )
    writeFileSync(
      backlog,
      readFileSync(
        backlog,
        'utf8',
      ).replace(
        /^- \[ \] api-v2.*\n/m,
        '',
      ),
    )
    appendFileSync(
      join(
        home,
        'state',
        'api-v2.status',
      ),
      'done: shipped API\n',
    )
    let closed: () => void = () => {}
    const changed = new Promise<void>(resolve => (closed = resolve))
    const watcher = watchHome({
      hydraId: 'default',
      home,
      onSync: ({ result }) => {
        if (result instanceof Error) {
          throw result
        }

        if (cardOf({
          home,
          task: 'api-v2',
        }).column === columnId({ role: 'done' })) {
          closed()
        }
      },
    })

    try {
      writeFileSync(
        join(
          home,
          'data',
          'done-archive.md',
        ),
        '# Done archive\n- [x] api-v2 - app: v2 API (repo: app)\n',
      )
      await Promise.race([
        changed,
        new Promise((
          _,
          reject,
        ) => setTimeout(
          () => reject(new Error('no sync after archive change')),
          5000,
        )),
      ])
      const api = cardOf({
        home,
        task: 'api-v2',
      })
      assert.equal(
        readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.moved' && e.cardId === api.id)
          .at(-1)?.reason,
        'done: shipped API',
      )
    } finally {
      watcher.close()
    }
  },
)

test(
  'sync never overwrites a link state another source refreshed',
  () => {
    const {
      home,
      env,
    } = copyFixture()
    appendFileSync(
      join(
        home,
        'state',
        'api-v2.meta',
      ),
      'pr=https://github.com/example/app/pull/41\n',
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    const api = cardOf({
      home,
      task: 'api-v2',
    })
    assert.equal(
      api.links[0]!.state,
      'open',
    )
    cli({ env }).run({
      args: [
        'link',
        api.id,
        '--url',
        'https://github.com/example/app/pull/41',
        '--state',
        'closed',
      ],
    })
    appendFileSync(
      join(
        home,
        'state',
        'api-v2.status',
      ),
      'working: still going\n',
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).links[0]!.state,
      'closed',
    )
  },
)

test(
  'a task with no pr in its meta takes the pull request URL ending its backlog title',
  () => {
    const { home } = copyFixture()
    writeFileSync(
      join(
        home,
        'state',
        'release-1.meta',
      ),
      'task=release-1\nkind=ship\n',
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      cardOf({
        home,
        task: 'release-1',
      }).links.map(link => [
        link.url,
        link.state,
      ]),
      [
        [
          'https://github.com/example/app/pull/40',
          'merged',
        ],
      ],
    )
    assert.deepEqual(
      cardOf({
        home,
        task: 'api-v2',
      }).links,
      [],
    )
  },
)

test(
  'a task whose records are gone drops its open decisions and its folder',
  () => {
    const { home } = copyFixture()
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).folder,
      '/tmp/fixture-worktree/api-v2',
    )
    rmSync(join(
      home,
      'state',
      'api-v2.meta',
    ))
    rmSync(join(
      home,
      'state',
      'api-v2.status',
    ))
    syncHome({
      hydraId: 'default',
      home,
    })
    const api = cardOf({
      home,
      task: 'api-v2',
    })
    assert.deepEqual(
      api.attention,
      [],
    )
    assert.equal(
      api.folder,
      undefined,
    )
    assert.equal(
      api.title,
      'v2 API with (optional) pagination',
    )
  },
)

for (const fallback of [
  false,
  true,
]) {
  test(
    `watch reconciles on start and folds in-place changes${fallback ? ' after EMFILE' : ''}`,
    async t => {
      if (fallback) {
        t.mock.method(
          fs,
          'watch',
          () => {
            throw Object.assign(
              new Error('watch limit reached'),
              { code: 'EMFILE' },
            )
          },
        )
        t.mock.method(
          console,
          'error',
          () => {},
        )
        syncBuiltinESMExports()
        t.after(() => {
          t.mock.restoreAll(); syncBuiltinESMExports()
        })
      }

      const { home } = copyFixture()
      const results: SyncResult[] = []
      let wake: () => void = () => {}
      const watcher = watchHome({
        hydraId: 'default',
        home,
        onSync: ({ result: r }) => {
          if (r instanceof Error) {
            throw r
          }

          results.push(r)
          wake()
        },
      })

      try {
        assert.equal(
          results[0]!.tasks,
          5,
        )
        const changed = new Promise<void>(resolve => (wake = resolve))
        appendFileSync(
          join(
            home,
            'state',
            'api-v2.status',
          ),
          'resolved [key=api-shape]: REST\n',
        )
        await Promise.race([
          changed,
          new Promise((
            _,
            reject,
          ) => setTimeout(
            () => reject(new Error('no sync after change')),
            5000,
          )),
        ])
        assert.deepEqual(
          cardOf({
            home,
            task: 'api-v2',
          }).attention.map(a => a.key),
          ['ci-token'],
        )
      } finally {
        watcher.close()
      }
    },
  )
}

test(
  'firstmate sync through the CLI',
  () => {
    const {
      home,
      env,
    } = copyFixture()
    const {
      run,
      fails,
    } = cli({ env })
    assert.match(
      run({
        args: [
          'firstmate',
          'sync',
          '--home',
          home,
        ],
      }),
      /home,5,[1-9]\d*$/m,
    )
    const out = run({ args: [] })
    const counts = {
      queued: 1,
      in_progress: 0,
      needs_you: 2,
      parked: 0,
      done: 2,
    }

    for (const column of loadHydra({ hydraId: 'default' }).state.config!.columns) {
      assert.match(
        out,
        new RegExp(`  "?${column.id}"?: ${counts[column.role as keyof typeof counts]}`),
      )
    }

    fails({
      args: [
        'firstmate',
        'sync',
        '--home',
        join(
          home,
          'data',
        ),
      ],
      code: 'VALIDATION_ERROR',
    })
  },
)

test(
  'serve --home folds the home into the Hydra without a separate watch',
  async () => {
    const {
      home,
      env,
    } = copyFixture()
    const server = spawn(
      process.execPath,
      [
        BIN,
        'serve',
        '--port',
        '0',
        '--home',
        home,
      ],
      {
        env,
        stdio: [
          'ignore',
          'pipe',
          'inherit',
        ],
      },
    )
    track({ child: server })

    try {
      let out = ''
      await new Promise<void>((
        resolve,
        reject,
      ) => {
        // Resolves on the first output that holds it; the bound only has to outlast a heavily loaded machine.
        const timer = setTimeout(
          () => reject(new Error(`serve did not start: ${out}`)),
          60000,
        )
        server.stdout.on(
          'data',
          (chunk: Buffer) => {
            out += chunk

            if (out.includes('help[1]')) {
              clearTimeout(timer)
              resolve()
            }
          },
        )
      })
      assert.match(
        out,
        /^firstmate: "watching 1 home"$/m,
      )
      assert.equal(
        cardOf({
          home,
          task: 'api-v2',
        }).title,
        'v2 API with (optional) pagination',
      )
    } finally {
      await stopAll()
    }
  },
)

test(
  'a running server watches a Firstmate home linked to its Hydra after it started',
  async () => {
    const {
      home,
      env,
    } = copyFixture()
    const server = await startServer({ hydraId: 'default' })

    try {
      cli({ env }).run({
        args: [
          'hydra',
          'set',
          '--hydra',
          'default',
          '--firstmate',
          home,
        ],
      })

      // Resolves as soon as the server folds the home in; the bound only has to outlast a heavily loaded machine.
      for (const end = Date.now() + 30000; !loadHydra({ hydraId: 'default' }).state.keys[`${homeKey({ home })}:api-v2`];) {
        assert.ok(
          Date.now() < end,
          'the linked home was not watched',
        )
        await new Promise(r => setTimeout(
          r,
          50,
        ))
      }
    } finally {
      await server.close()
    }
  },
)

test(
  'a Firstmate outcome is a source observation: undo and clear refuse it',
  () => {
    const {
      home,
      env,
    } = copyFixture()
    const {
      run,
      fails,
    } = cli({ env })
    syncHome({
      hydraId: 'default',
      home,
    })
    const scout = cardOf({
      home,
      task: 'docs-scout',
    })
    const recorded = readEvents({ hydraId: 'default' }).find(e => e.type === 'card.outcome' && e.cardId === scout.id)!
    fails({
      args: [
        'undo',
        recorded.id,
      ],
      code: 'NOT_UNDOABLE',
    })
    fails({
      args: [
        'outcome',
        scout.id,
        'cancelled',
      ],
      code: 'SOURCE_OWNED',
    })
    run({
      args: [
        'move',
        scout.id,
        'needs_you',
        '--actor',
        'web',
      ],
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      cardOf({
        home,
        task: 'docs-scout',
      }).outcome,
      {
        state: 'done',
        source: 'firstmate',
      },
    )
    assert.equal(
      cardOf({
        home,
        task: 'docs-scout',
      }).column,
      columnId({ role: 'done' }),
      'a default column follows the record',
    )
  },
)

test(
  "a card in the owner's own column stays there until its Firstmate record changes",
  () => {
    const {
      home,
      env,
    } = copyFixture()
    const { run } = cli({ env })
    syncHome({
      hydraId: 'default',
      home,
    })
    run({
      args: [
        'column',
        'create',
        '--id',
        'custom:mine',
        '--title',
        'Mine',
      ],
    })
    const scout = cardOf({
      home,
      task: 'docs-scout',
    })
    run({
      args: [
        'move',
        scout.id,
        'custom:mine',
        '--actor',
        'web',
      ],
    })
    assert.deepEqual(
      syncHome({
        hydraId: 'default',
        home,
      }).appended,
      0,
    )
    assert.equal(
      cardOf({
        home,
        task: 'docs-scout',
      }).column,
      'custom:mine',
    )
    appendFileSync(
      join(
        home,
        'state',
        'docs-scout.status',
      ),
      'done: survey refreshed\n',
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home,
        task: 'docs-scout',
      }).column,
      columnId({ role: 'done' }),
    )
    assert.equal(
      readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.moved')
        .at(-1)!.reason,
      'done: survey refreshed',
    )
  },
)

test(
  'backlog holds park a task or wait on the owner the way Firstmate classifies them',
  () => {
    const { home } = copyFixture()
    const backlog = join(
      home,
      'data',
      'backlog.md',
    )
    const queued = [
      '- [ ] held-1 - app: waiting on the owner (repo: app) (hold: fm-hold-v1:eA==) (hold-kind: captain)',
      '  Captain hold set: 2026-10-10',
      '- [ ] held-2 - app: parked until next month (repo: app) (hold: fm-hold-v1:eA==) (hold-kind: captain) (hold-until: 2026-11-08)',
      '- [ ] held-3 - app: an old idea (repo: app) (hold: fm-hold-v1:eA==) (hold-kind: captain) (since 2026-09-01)',
      '- [ ] held-4 - app: after api blocked-by: api-v2 (repo: app) (hold: fm-hold-v1:eA==) (hold-kind: captain)',
      '- [ ] held-5 - app: deferred (repo: app) (hold: fm-hold-v1:eA==) (hold-kind: release)',
      '- [ ] held-6 - app: a hold that lapsed (repo: app) (hold: fm-hold-v1:eA==) (hold-kind: release) (hold-until: 2026-10-01)',
    ]
    const rows = readFileSync(
      backlog,
      'utf8',
    ).split('\n')
    rows.splice(
      rows.indexOf('## Queued') + 1,
      0,
      ...queued,
    )
    writeFileSync(
      backlog,
      rows.join('\n'),
    )
    syncHome({
      hydraId: 'default',
      home,
      at: '2026-10-15T10:00:00.000Z',
    })
    const roles = Object.fromEntries([
      1,
      2,
      3,
      4,
      5,
      6,
    ].map(n => [
      `held-${n}`,
      loadHydra({ hydraId: 'default' }).state.config!.columns.find(c => c.id === cardOf({
        home,
        task: `held-${n}`,
      }).column)!.role,
    ]))
    assert.deepEqual(
      roles,
      {
        'held-1': 'needs_you',
        'held-2': 'parked',
        'held-3': 'parked',
        'held-4': 'parked',
        'held-5': 'parked',
        'held-6': 'queued',
      },
    )
    assert.equal(
      readEvents({ hydraId: 'default' }).find(e => e.type === 'card.moved' && e.cardId === cardOf({
        home,
        task: 'held-2',
      }).id)?.reason,
      'Held in the Firstmate backlog until 2026-11-08',
    )
  },
)

test(
  "a task's decisions, reports and Captain's intent show on its card",
  () => {
    const {
      home,
      env,
    } = copyFixture()
    const { run } = cli({ env })
    syncHome({
      hydraId: 'default',
      home,
    })
    const api = run({
      args: [
        'card',
        cardOf({
          home,
          task: 'api-v2',
        }).id,
      ],
    })
    assert.match(
      api,
      /^ {2}decisions\[1\]\{at,source,text\}:\n {4}"2026-10-13T14:01:40.000Z",firstmate,"needs-decision \[api-shape\]: REST or RPC for the v2 endpoints\?"$/m,
    )
    assert.match(
      api,
      /^ {2}context\[1\]\{at,source,text\}:\n {4}"[^"]+",firstmate,"Captain's intent:\\nShip the v2 API so partners can page through invoices\.\\nKeep v1 working until every partner moves\."$/m,
    )
    assert.doesNotMatch(
      api,
      /Firstmate spec|Setup text/,
    )
    assert.match(
      run({
        args: [
          'card',
          cardOf({
            home,
            task: 'release-1',
          }).id,
        ],
      }),
      /^ {2}summary\[1\]\{at,source,text\}:\n {4}"2026-10-13T14:06:40.000Z",firstmate,"done: PR https:\/\/github.com\/example\/app\/pull\/40 checks green"$/m,
    )
  },
)

test(
  'a Firstmate outcome follows the backlog on every sync',
  () => {
    const { home } = copyFixture()
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      cardOf({
        home,
        task: 'docs-scout',
      }).outcome,
      {
        state: 'done',
        source: 'firstmate',
      },
    )
    appendFileSync(
      join(
        home,
        'state',
        'docs-scout.status',
      ),
      'failed: rerun broke\n',
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      cardOf({
        home,
        task: 'docs-scout',
      }).outcome,
      {
        state: 'failed',
        note: 'closed after failure',
        closed: true,
        source: 'firstmate',
      },
    )
    moveRow({
      home,
      task: 'docs-scout',
      section: '## In flight',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home,
        task: 'docs-scout',
      }).outcome,
      undefined,
    )
    assert.equal(
      cardOf({
        home,
        task: 'docs-scout',
      }).column,
      columnId({ role: 'needs_you' }),
      'a reopened task whose last line failed needs the owner',
    )
  },
)

test(
  "reply sends through the home's fm-send with FM_HOME and records receipts",
  () => {
    const {
      home,
      env,
    } = copyFixture()
    const {
      run,
      fails,
    } = cli({ env })
    syncHome({
      hydraId: 'default',
      home,
    })
    const api = cardOf({
      home,
      task: 'api-v2',
    })
    const sent = () => (existsSync(join(
      home,
      'sent.log',
    )) ? readFileSync(
        join(
          home,
          'sent.log',
        ),
        'utf8',
      ) : '')
    const exit = ({ code }: { code: string }) => writeFileSync(
      join(
        home,
        'send-exit',
      ),
      code,
    )
    const reply = ({
      key,
      text,
      extra = [],
    }: {
      key?: string
      text: string
      extra?: string[]
    }) => run({
      args: [
        'reply',
        api.id,
        '--text',
        text,
        ...(key ? [
          '--idempotency-key',
          key,
        ] : []),
        ...extra,
        '--home',
        home,
      ],
    })

    assert.match(
      reply({
        key: 'k1',
        text: 'Use REST',
        extra: [
          '--resolve-key',
          'api-shape',
        ],
      }),
      /state: delivered/,
    )
    assert.equal(
      sent(),
      `FM_HOME=${home}\narg=api-v2\narg=--resolve-key\narg=api-shape\narg=Use REST\n---\n`,
    )
    assert.match(
      reply({
        key: 'k1',
        text: 'Use REST',
      }),
      /sent: false/,
    )
    assert.equal(
      sent().split('---').length,
      2,
    )
    const delivered = readEvents({ hydraId: 'default' }).filter(event => event.type === 'card.replied' && event.data.reply === 'k1' && event.data.state === 'delivered')
    assert.equal(
      delivered.length,
      1,
    )
    assert.ok(delivered[0]?.type === 'card.replied')
    assert.deepEqual(
      delivered[0].data.decision,
      {
        question: api.attention.find(request => request.key === 'api-shape')?.text,
        answer: 'Use REST',
      },
    )
    // The answer does not close the decision by itself; Firstmate's resolved line does.
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).attention.length,
      2,
    )

    // A failed send can be retried; a send that may have landed (exit 1 or 3) is never resent.
    exit({ code: '2' })
    assert.match(
      reply({
        key: 'k2',
        text: 'ping',
      }),
      /state: failed/,
    )
    exit({ code: '0' })
    assert.match(
      reply({
        key: 'k2',
        text: 'ping',
      }),
      /state: delivered/,
    )
    exit({ code: '3' })
    assert.match(
      reply({
        key: 'k3',
        text: 'maybe',
      }),
      /state: delivery_unknown/,
    )
    exit({ code: '1' })
    const unknown = reply({
      key: 'k4',
      text: 'remote',
    })
    assert.match(
      unknown,
      /state: delivery_unknown/,
    )
    assert.match(
      unknown,
      /may have landed/,
    )
    assert.match(
      reply({
        key: 'k4',
        text: 'remote',
      }),
      /sent: false/,
    )
    // The send went through but its outcome could not be recorded: the receipt still
    // names the reply, and a retry finds it queued and does not resend.
    exit({ code: '0' })
    writeFileSync(
      join(
        home,
        'tear',
      ),
      '',
    )
    const unrecorded = reply({ text: 'torn' })
    assert.match(
      unrecorded,
      /state: delivered/,
    )
    assert.match(
      unrecorded,
      /recordError: /,
    )
    rmSync(join(
      home,
      'tear',
    ))
    run({ args: ['repair'] })
    const retry = reply({
      key: /reply: (r\d+)/.exec(unrecorded)![1]!,
      text: 'torn',
    })
    assert.match(
      retry,
      /state: queued/,
    )
    assert.match(
      retry,
      /sent: false/,
    )
    assert.equal(
      sent().split('---').length - 1,
      6,
    )

    fails({
      args: [
        'reply',
        cardOf({
          home,
          task: 'hotfix-2',
        }).id,
        '--text',
        'x',
        '--resolve-key',
        '@status',
        '--home',
        home,
      ],
      code: 'VALIDATION_ERROR',
    })
    fails({
      args: [
        'reply',
        api.id,
        '--text=--resolve-key x',
        '--home',
        home,
      ],
      code: 'VALIDATION_ERROR',
    })
    // A task id that is not Firstmate's would reach fm-send as an option.
    const crafted = join(
      home,
      'crafted.json',
    )
    writeFileSync(
      crafted,
      JSON.stringify({
        title: 'crafted',
        source: {
          adapter: 'firstmate',
          instanceId: home,
          objectId: '--resolve-key',
        },
      }),
    )
    run({
      args: [
        'push',
        '--key',
        'crafted',
        '--file',
        crafted,
      ],
    })
    fails({
      args: [
        'reply',
        'crafted',
        '--text',
        'x',
        '--home',
        home,
      ],
      code: 'NO_ROUTE',
    })
    fails({
      args: [
        'reply',
        api.id,
        '--text',
        'x',
        '--home',
        copyFixture().home,
      ],
      code: 'VALIDATION_ERROR',
    })
  },
)

// Writes a task's meta in a fresh worktree, launched in a Paseo terminal when one is named.
function launched({
  home,
  task,
  worktree,
  terminal,
}: {
  home: string
  task: string
  worktree: string
  terminal?: string
}) {
  writeFileSync(
    join(
      home,
      'state',
      `${task}.meta`,
    ),
    `task=${task}\nkind=ship\nworktree=${worktree}\n${terminal ? `paseo_terminal_id=${terminal}\n` : ''}`,
  )
}

// Spools a hook event for a session in the worktree and folds it in.
function session({
  id,
  session,
  worktree,
  home,
  event = 'SessionStart',
  harness = 'claude',
  terminal,
  extra = {},
}: {
  id: string
  session: string
  worktree: string
  home: string
  event?: string
  harness?: 'claude' | 'codex'
  terminal?: object
  extra?: object
}) {
  spoolWrite({
    hydraId: 'default',
    entry: {
      v: 1,
      id,
      at: '2026-10-14T00:00:00Z',
      harness,
      event,
      payload: {
        session_id: session,
        cwd: worktree,
        prompt: 'x',
        ...extra,
      },
      ...(terminal ? { terminal } : {}),
    },
  })
  syncHome({
    hydraId: 'default',
    home,
  })
}

const ownCard = ({ key }: { key: string }) => !!loadHydra({ hydraId: 'default' }).state.keys[key]

test(
  "a hook session in a task's worktree joins the task card, which keeps fm-send",
  () => {
    const {
      home,
      env,
    } = copyFixture()
    const worktree = mkdtempSync(join(
      tmpdir(),
      'pnyx-wt-',
    ))
    const meta = join(
      home,
      'state',
      'api-v2.meta',
    )
    writeFileSync(
      meta,
      readFileSync(
        meta,
        'utf8',
      ).replace(
        /^worktree=.*$/m,
        `worktree=${worktree}`,
      ),
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    const fm = ({
      id,
      event,
      extra,
    }: {
      id: string
      event: string
      extra?: object
    }) =>
      session({
        id,
        session: 'fm-s',
        worktree,
        home,
        event,
        extra,
      })
    const terminal = {
      tty: '/dev/ttys042',
      pid: '4242',
      program: 'tmux',
      tmux: '/tmp/tmux-1/default',
      tmuxPane: '%3',
    }
    // The hook reports the folder as the session saw it; the join compares canonical paths.
    session({
      id: 'h1',
      session: 'fm-s',
      worktree,
      home,
      terminal,
      extra: { transcript_path: '/x/fm-s.jsonl' },
    })
    fm({
      id: 'h2',
      event: 'SubagentStart',
      extra: { agent_id: 'a1' },
    })
    const { state } = loadHydra({ hydraId: 'default' })
    const api = cardOf({
      home,
      task: 'api-v2',
    })
    assert.equal(
      api.folder,
      realpathSync(worktree),
    )
    assert.equal(
      api.agent?.sessionId,
      'fm-s',
    )
    assert.deepEqual(
      api.terminal,
      terminal,
    )
    assert.equal(
      ownCard({ key: 'claude:fm-s' }),
      false,
    )
    assert.equal(
      state.cards[state.keys['claude:fm-s/a1']!]!.parentId,
      api.id,
    )

    assert.match(
      cli({ env }).run({
        args: [
          'reply',
          api.id,
          '--text',
          'Use REST',
          '--home',
          home,
        ],
      }),
      /state: delivered/,
    )
    assert.match(
      readFileSync(
        join(
          home,
          'sent.log',
        ),
        'utf8',
      ),
      /arg=api-v2\narg=Use REST/,
    )

    fm({
      id: 'h3',
      event: 'PermissionRequest',
      extra: {
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
      },
    })
    const asks = cardOf({
      home,
      task: 'api-v2',
    }).attention.filter(a => a.key.startsWith('hook:'))
    assert.equal(
      asks.length,
      1,
    )
    assert.equal(
      asks[0]!.blocking,
      true,
    )
    fm({
      id: 'h4',
      event: 'SessionEnd',
    })
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).outcome,
      undefined,
      'a session end never closes the task',
    )

    // A closed task gives its worktree up, so the next session there keeps its own card.
    moveRow({
      home,
      task: 'api-v2',
      section: '## Done',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).folder,
      undefined,
    )
    session({
      id: 'h5',
      session: 'next',
      worktree,
      home,
    })
    assert.ok(ownCard({ key: 'claude:next' }))
  },
)

test(
  'a session joins the task launched in its worktree; only a session in its terminal takes over',
  () => {
    const { home } = copyFixture()
    const worktree = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-wt-',
    )))
    const tty = {
      tty: '/dev/ttys042',
      pid: '4242',
      program: 'kitty',
    }
    const start = ({
      id,
      name,
      terminal,
      extra,
    }: {
      id: string
      name: string
      terminal: object
      extra?: object
    }) =>
      session({
        id,
        session: name,
        worktree,
        home,
        terminal,
        extra,
      })
    const wtB = () => cardOf({
      home,
      task: 'wt-b',
    })

    // The pool hands the worktree from a finished task, whose records are gone, to the next.
    launched({
      home,
      task: 'wt-a',
      worktree,
      terminal: 'term-a',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    rmSync(join(
      home,
      'state',
      'wt-a.meta',
    ))
    launched({
      home,
      task: 'wt-b',
      worktree,
      terminal: 'term-b',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      wtB().terminal,
      { paseoTerminal: 'term-b' },
    )
    const transcript = join(
      worktree,
      's-b.jsonl',
    )
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Retain before clear',
            },
          ],
        },
      }) + '\n',
    )
    start({
      id: 'h1',
      name: 's-b',
      terminal: {
        ...tty,
        paseoTerminal: 'term-b',
      },
      extra: { transcript_path: transcript },
    })
    assert.equal(
      wtB().agent?.sessionId,
      's-b',
    )
    assert.equal(
      wtB().terminal?.pid,
      '4242',
    )
    assert.equal(
      ownCard({ key: 'claude:s-b' }),
      false,
    )

    // A headless run the worker starts in its worktree inherits the task's terminal
    // but has no tty of its own, so it keeps its own card.
    start({
      id: 'h2',
      name: 's-child',
      terminal: {
        program: 'kitty',
        paseoTerminal: 'term-b',
      },
    })
    assert.equal(
      wtB().agent?.sessionId,
      's-b',
    )
    assert.equal(
      ownCard({ key: 'claude:s-child' }),
      true,
    )

    // Claude Code's /clear starts a new session on the same tty, which continues the
    // card and keeps what the old session said.
    start({
      id: 'h3',
      name: 's-b2',
      terminal: {
        ...tty,
        paseoTerminal: 'term-b',
      },
      extra: { source: 'clear' },
    })
    assert.equal(
      wtB().agent?.sessionId,
      's-b2',
    )
    assert.deepEqual(
      wtB().sessionIds,
      ['claude-code:s-b2'],
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.sessions?.['claude-code:s-b']?.taskId,
      null,
    )
    rmSync(transcript)
    assert.ok(readEvents({ hydraId: 'default' }).some(e => e.type === 'chat.message'
      && e.data.session === 'claude-code:s-b' && e.data.text === 'Retain before clear'))
    start({
      id: 'h4',
      name: 's-b',
      terminal: {
        ...tty,
        paseoTerminal: 'term-b',
      },
    })
    assert.equal(
      wtB().agent?.sessionId,
      's-b2',
    )
    assert.equal(
      ownCard({ key: 'claude:s-b' }),
      true,
    )

    // A relaunch in a new terminal takes the session started there.
    launched({
      home,
      task: 'wt-b',
      worktree,
      terminal: 'term-b3',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      wtB().terminal,
      { paseoTerminal: 'term-b3' },
    )
    start({
      id: 'h5',
      name: 's-b3',
      terminal: {
        ...tty,
        paseoTerminal: 'term-b3',
      },
    })
    assert.equal(
      wtB().agent?.sessionId,
      's-b3',
    )

    // Follow-up tasks launched into the same worktree: each session's own Paseo terminal tells them apart.
    launched({
      home,
      task: 'wt-c',
      worktree,
      terminal: 'term-c',
    })
    launched({
      home,
      task: 'wt-d',
      worktree,
      terminal: 'term-d',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    start({
      id: 'h6',
      name: 's-d',
      terminal: {
        ...tty,
        paseoTerminal: 'term-d',
      },
    })
    assert.equal(
      cardOf({
        home,
        task: 'wt-d',
      }).agent?.sessionId,
      's-d',
    )
    assert.equal(
      cardOf({
        home,
        task: 'wt-c',
      }).agent,
      undefined,
    )
  },
)

test(
  'a session outside Paseo joins a task with no recorded terminal and keeps its facts',
  () => {
    const { home } = copyFixture()
    const worktree = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-wt-',
    )))
    launched({
      home,
      task: 'wt-t',
      worktree,
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    const terminal = {
      tty: '/dev/ttys042',
      pid: '4242',
      program: 'tmux',
    }
    session({
      id: 'h1',
      session: 's-tmux',
      worktree,
      home,
      terminal,
    })
    assert.equal(
      cardOf({
        home,
        task: 'wt-t',
      }).agent?.sessionId,
      's-tmux',
    )
    assert.deepEqual(
      cardOf({
        home,
        task: 'wt-t',
      }).terminal,
      terminal,
    )
  },
)

test(
  'a task launched in a Paseo terminal takes only a session from that terminal, whatever event comes first',
  () => {
    const { home } = copyFixture()
    const worktree = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-wt-',
    )))
    launched({
      home,
      task: 'wt-p',
      worktree,
      terminal: 'term-p',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    const wtP = () => cardOf({
      home,
      task: 'wt-p',
    })

    // Sessions outside the task's terminal, or with none, keep their own cards.
    session({
      id: 'h1',
      session: 's-tmux',
      worktree,
      home,
      terminal: {
        tty: '/dev/ttys042',
        pid: '4242',
        program: 'tmux',
      },
    })
    session({
      id: 'h2',
      session: 's-other',
      worktree,
      home,
      harness: 'codex',
      terminal: {
        tty: '/dev/ttys050',
        pid: '5050',
        paseoTerminal: 'term-elsewhere',
      },
    })
    session({
      id: 'h3',
      session: 's-bare',
      worktree,
      home,
      harness: 'codex',
      event: 'PreToolUse',
    })
    assert.equal(
      wtP().agent,
      undefined,
    )
    assert.deepEqual(
      wtP().terminal,
      { paseoTerminal: 'term-p' },
    )

    for (const key of [
      'claude:s-tmux',
      'codex:s-other',
      'codex:s-bare',
    ]) {
      assert.equal(
        ownCard({ key }),
        true,
        key,
      )
    }

    // A worker already running when its hooks were trusted first reports a tool call,
    // which shows only its Paseo terminal; it joins, and its later events follow.
    session({
      id: 'h4',
      session: 's-worker',
      worktree,
      home,
      harness: 'codex',
      event: 'PreToolUse',
      terminal: { paseoTerminal: 'term-p' },
    })
    assert.equal(
      wtP().agent?.sessionId,
      's-worker',
    )
    session({
      id: 'h5',
      session: 's-worker',
      worktree,
      home,
      harness: 'codex',
      event: 'UserPromptSubmit',
      terminal: {
        tty: '/dev/ttys051',
        pid: '5151',
        paseoTerminal: 'term-p',
      },
    })
    assert.equal(
      wtP().agent?.sessionId,
      's-worker',
    )
    assert.equal(
      wtP().terminal?.paseoTerminal,
      'term-p',
    )
    assert.equal(
      ownCard({ key: 'codex:s-worker' }),
      false,
    )
  },
)

test(
  'a session that joined a Paseo task and then shows another terminal reports to its own card',
  () => {
    const { home } = copyFixture()
    const worktree = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-wt-',
    )))
    launched({
      home,
      task: 'wt-r',
      worktree,
      terminal: 'term-r',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    const codex = ({
      id,
      name,
      event,
      terminal,
    }: {
      id: string
      name: string
      event: string
      terminal: object
    }) =>
      session({
        id,
        session: name,
        worktree,
        home,
        harness: 'codex',
        event,
        terminal,
      })
    codex({
      id: 'h1',
      name: 's-a',
      event: 'PreToolUse',
      terminal: { paseoTerminal: 'term-r' },
    })
    assert.equal(
      cardOf({
        home,
        task: 'wt-r',
      }).agent?.sessionId,
      's-a',
    )
    codex({
      id: 'h2',
      name: 's-a',
      event: 'UserPromptSubmit',
      terminal: {
        tty: '/dev/ttys060',
        pid: '6060',
        program: 'tmux',
      },
    })
    assert.equal(
      ownCard({ key: 'codex:s-a' }),
      true,
    )
    assert.deepEqual(
      cardOf({
        home,
        task: 'wt-r',
      }).terminal,
      { paseoTerminal: 'term-r' },
    )
    codex({
      id: 'h3',
      name: 's-worker',
      event: 'SessionStart',
      terminal: {
        tty: '/dev/ttys061',
        pid: '6161',
        paseoTerminal: 'term-r',
      },
    })
    assert.equal(
      cardOf({
        home,
        task: 'wt-r',
      }).agent?.sessionId,
      's-worker',
    )
    assert.equal(
      ownCard({ key: 'codex:s-worker' }),
      false,
    )
  },
)

test(
  "a task card's setting changes go to the orchestrator as request notes, never into the worker",
  () => {
    const {
      home,
      env,
    } = copyFixture()
    const worktree = mkdtempSync(join(
      tmpdir(),
      'pnyx-wt-',
    ))
    const meta = join(
      home,
      'state',
      'api-v2.meta',
    )
    writeFileSync(
      meta,
      readFileSync(
        meta,
        'utf8',
      ).replace(
        /^worktree=.*$/m,
        `worktree=${worktree}`,
      ),
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    session({
      id: 'h1',
      session: 'fm-s',
      worktree,
      home,
      terminal: {
        tty: '/dev/ttys042',
        pid: '4242',
      },
      extra: { model: 'claude-sonnet-5-5' },
    })
    const api = cardOf({
      home,
      task: 'api-v2',
    })
    const { run } = cli({ env })
    const agent = ({ args }: { args: string[] }) => run({
      args: [
        'agent',
        api.id,
        ...args,
        '--home',
        home,
      ],
    })
    const notes = () => readFileSync(
      join(
        home,
        'inbox.log',
      ),
      'utf8',
    ).split('---\n')
      .filter(n => n.includes('arg=note'))
    const note = ({
      id,
      text,
    }: {
      id: string
      text: string
    }) =>
      `FM_HOME=${home}\narg=note\narg=--request-id\narg=pnyx:default:${api.id}:${id}\narg=--json\narg=--\narg=${text}\n`
    const inboxExit = ({ code }: { code: string }) => writeFileSync(
      join(
        home,
        'inbox-exit',
      ),
      code,
    )

    assert.match(
      agent({ args: [] }),
      /route: "firstmate:inbox"[\s\S]*mode,unknown,next,yes/,
    )
    assert.match(
      agent({
        args: [
          'model',
          'opus',
          '--idempotency-key',
          'm1',
        ],
      }),
      /sent: delivered[\s\S]*confirmed: false[\s\S]*Firstmate note n1 asks/,
    )
    assert.deepEqual(
      notes(),
      [
        note({
          id: 'm1',
          text: 'Pnyx: please switch the worker on task api-v2 (Claude Code) to model opus.',
        }),
      ],
    )
    agent({
      args: [
        'model',
        'opus',
        '--idempotency-key',
        'm1',
      ],
    })
    assert.equal(
      notes().length,
      1,
    )

    // A key change is a request too, even while the worker waits on its own prompt:
    // nothing reaches the worker's session, so fm-send never runs.
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h2',
        at: '2026-10-14T00:01:00Z',
        harness: 'claude',
        event: 'PermissionRequest',
        payload: {
          session_id: 'fm-s',
          cwd: worktree,
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
      },
    })
    assert.match(
      agent({
        args: [
          'mode',
          'next',
          '--idempotency-key',
          'm2',
        ],
      }),
      /sent: delivered/,
    )
    assert.equal(
      notes().at(-1),
      note({
        id: 'm2',
        text: 'Pnyx: please switch the worker on task api-v2 (Claude Code) to the next permission mode.',
      }),
    )
    assert.equal(
      existsSync(join(
        home,
        'sent.log',
      )),
      false,
    )

    // A note saved but not announced may still reach the orchestrator; one not saved fails.
    inboxExit({ code: '3' })
    assert.match(
      agent({
        args: [
          'effort',
          'high',
          '--idempotency-key',
          'm3',
        ],
      }),
      /sent: delivery_unknown[\s\S]*fm-inbox.sh announce n3/,
    )
    inboxExit({ code: '1' })
    assert.match(
      agent({
        args: [
          'fast',
          'on',
          '--idempotency-key',
          'm4',
        ],
      }),
      /sent: failed[\s\S]*Nothing was changed: fm-inbox: fake note failed/,
    )
    inboxExit({ code: '0' })

    // A Codex worker is offered Codex's settings, and its changes go the same way.
    const fix = join(
      home,
      'state',
      'hotfix-2.meta',
    )
    const codexTree = mkdtempSync(join(
      tmpdir(),
      'pnyx-wt-',
    ))
    writeFileSync(
      fix,
      `${readFileSync(
        fix,
        'utf8',
      )}worktree=${codexTree}\n`,
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    session({
      id: 'h4',
      session: 'cx-s',
      worktree: codexTree,
      home,
      harness: 'codex',
      terminal: {
        tty: '/dev/ttys043',
        pid: '4343',
      },
    })
    const hotfix = cardOf({
      home,
      task: 'hotfix-2',
    })
    assert.equal(
      hotfix.agent?.provider,
      'codex',
    )
    const offered = run({
      args: [
        'agent',
        hotfix.id,
        '--home',
        home,
      ],
    })
    assert.match(
      offered,
      /model,unknown,gpt-6.1-sol gpt-6-astra gpt-6-sol gpt-6-luna,yes/,
    )
    assert.match(
      offered,
      /approval,unknown,untrusted on-request never,yes/,
    )
    assert.match(
      run({
        args: [
          'agent',
          hotfix.id,
          'approval',
          'on-request',
          '--home',
          home,
        ],
      }),
      /sent: delivered[\s\S]*confirmed: false/,
    )
    assert.match(
      notes().at(-1)!,
      /arg=Pnyx: please switch the worker on task hotfix-2 \(Codex\) to approval policy on-request\.\n$/,
    )
    assert.equal(
      existsSync(join(
        home,
        'sent.log',
      )),
      false,
    )
  },
)

test(
  'linking a Firstmate home preserves the columns and Done time of existing unconfigured work',
  () => {
    const {
      home,
      env,
    } = copyFixture()
    cli({ env }).run({
      args: [
        'task',
        'create',
        '--key',
        'kept',
        '--title',
        'Existing completion',
        '--column',
        'done',
      ],
    })
    const before = loadHydra({ hydraId: 'default' }).state
    const id = before.keys.kept!
    syncHome({
      hydraId: 'default',
      home,
    })
    const after = loadHydra({ hydraId: 'default' }).state
    assert.equal(
      after.cards[id]?.column,
      before.cards[id]?.column,
    )
    assert.equal(
      after.cards[id]?.doneAt,
      before.cards[id]?.doneAt,
    )
  },
)
