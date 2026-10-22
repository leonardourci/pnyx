// Firstmate integration against a fixture home copied into a temp dir, with a fake
// fm-send. Never points at a real Firstmate home.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadHydra, readEvents, spoolWrite } from '../src/store/hydra-store.ts'
import { captainsIntent, homeKey, parseBacklog, resolveHome } from '../src/integrations/firstmate/home.ts'
import { latestActivity, openDecisions, parseStatusLine, statusNotes } from '../src/integrations/firstmate/status.ts'
import { syncHome, watchHome, type SyncResult } from '../src/integrations/firstmate/sync.ts'
import { roleColumn } from '../src/core/hydra.ts'
import { stopAll, track } from './processes.ts'
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
  "status lines follow Firstmate's key grammar",
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
    assert.equal(
      parseStatusLine({ line: 'blocked [at=10:30]: stuck' }).note,
      'stuck',
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
  },
)

test(
  'status headers ignore complete timestamps and preserve note text',
  () => {
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
      parseStatusLine({ line: 'blocked [at=10:30: waiting' }).note,
      '30: waiting',
    )
    assert.equal(
      parseStatusLine({ line: 'working [at=[key=hidden]]' }).declares,
      false,
    )
    assert.equal(
      parseStatusLine({ line: 'resolved: [key=api] [key=later] keep this' }).note,
      '[key=later] keep this',
    )
    assert.equal(
      parseStatusLine({ line: 'resolved [key=api]: [key=later] keep this' }).note,
      '[key=later] keep this',
    )
    assert.equal(
      parseStatusLine({ line: 'resolved: [key=bad slug] keep this' }).note,
      '[key=bad slug] keep this',
    )
    assert.equal(
      parseStatusLine({ line: 'resolved corr=invalid [key=api]: keep this' }).verb,
      'resolved corr=invalid',
    )
    assert.equal(
      parseStatusLine({ line: 'resolved corr=0123456789abcdef corr=fedcba9876543210 [key=api]: keep this' }).verb,
      'resolved',
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
    const brief = readFileSync(
      join(
        FIXTURE,
        'data',
        'api-v2',
        'brief.md',
      ),
      'utf8',
    )
    assert.equal(
      captainsIntent({ brief }),
      'Ship the v2 API so partners can page through invoices.\nKeep v1 working until every partner moves.',
    )
    assert.equal(
      captainsIntent({ brief: '# Task\nno intent here' }),
      undefined,
    )
  },
)

test(
  'backlog rows give titles, repo tags and merged state',
  () => {
    const parsed = parseBacklog({
      text: readFileSync(
        join(
          FIXTURE,
          'data',
          'backlog.md',
        ),
        'utf8',
      ),
    })
    const rows = new Map([...parsed].map(([
      id,
      {
        raw,
        section,
        ...fields
      },
    ]) => {
      assert.ok(raw.includes(id) && section)

      return [
        id,
        fields,
      ]
    }))
    assert.deepEqual(
      rows.get('api-v2'),
      {
        title: 'app: v2 API with (optional) pagination',
        repo: 'app',
        done: false,
        merged: false,
      },
    )
    assert.deepEqual(
      rows.get('release-1'),
      {
        title: 'app: cut release 1 https://github.com/example/app/pull/40',
        repo: 'app',
        done: true,
        merged: true,
      },
    )
    assert.equal(
      rows.get('later-1')?.merged,
      false,
    )
    assert.deepEqual(
      rows.get('docs-scout'),
      {
        title: 'app: survey the docs',
        repo: 'docs',
        done: true,
        merged: false,
      },
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
    assert.equal(
      parent.tags[0],
      'firstmate',
    )
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
    assert.deepEqual(
      api.tags,
      ['app'],
    )
    assert.equal(
      api.parentId,
      undefined,
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
      api.links,
      [],
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
    assert.deepEqual(
      scout.attention,
      [],
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

test(
  'a column edit before sync does not stand in for the Firstmate Hydra, whose default columns can be renamed but not deleted',
  () => {
    const {
      home,
      env,
    } = copyFixture()
    execFileSync(
      process.execPath,
      [
        BIN,
        'column',
        'rename',
        'needs_you',
        '--title',
        'Your turn',
      ],
      { env },
    )
    execFileSync(
      process.execPath,
      [
        BIN,
        'column',
        'create',
        '--id',
        'custom:mine',
        '--title',
        'Mine',
      ],
      { env },
    )
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
        'Your turn',
        'Parked',
        'Done',
        'Mine',
      ],
    )
    assert.equal(
      cardOf({
        home,
        task: 'docs-scout',
      }).column,
      columnId({ role: 'done' }),
    )
    const {
      fails,
      run,
    } = cli({ env })
    fails({
      args: [
        'column',
        'delete',
        'parked',
        '--actor',
        'web',
      ],
      code: 'VALIDATION_ERROR',
    })
    assert.throws(
      () => run({
        args: [
          'column',
          'delete',
          'needs_you',
          '--actor',
          'web',
        ],
      }),
      (error: { stdout: string }) => /Can't delete: this column is tied to Firstmate's records/.test(error.stdout),
    )
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
        'describe',
        'done',
        '--description',
        'Closed in Firstmate.',
      ],
    })
    run({
      args: [
        'column',
        'delete',
        'custom:mine',
        '--actor',
        'web',
      ],
    })
    appendFileSync(
      join(
        home,
        'state',
        'hotfix-2.status',
      ),
      'done: patched\n',
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
      rows.findIndex(l => l.startsWith('- [ ] hotfix-2')),
      1,
    )
    rows.splice(
      rows.indexOf('## Done') + 1,
      0,
      row!.replace(
        '[ ]',
        '[x]',
      ),
    )
    writeFileSync(
      backlog,
      rows.join('\n'),
    )
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
    run({
      args: [
        'column',
        'reorder',
        'done',
        '--before',
        'queued',
        '--actor',
        'web',
      ],
    })
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.config!.columns[0]!.id,
      columnId({ role: 'done' }),
    )
  },
)

test(
  'a failed task closed in the backlog records a closed failure and moves to Done',
  () => {
    const { home } = copyFixture()
    syncHome({
      hydraId: 'default',
      home,
    })
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
      rows.findIndex(l => l.startsWith('- [ ] hotfix-2')),
      1,
    )
    rows.splice(
      rows.indexOf('## Done') + 1,
      0,
      row!.replace(
        '[ ]',
        '[x]',
      ),
    )
    writeFileSync(
      backlog,
      rows.join('\n'),
    )
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
      {
        state: 'failed',
        note: 'closed after failure',
        closed: true,
        source: 'firstmate',
      },
    )
    assert.equal(
      hotfix.column,
      columnId({ role: 'done' }),
    )
  },
)

test(
  'a blocked task closed in the backlog clears its request, records done and moves to Done',
  () => {
    const { home } = copyFixture()
    writeFileSync(
      join(
        home,
        'state',
        'hotfix-2.status',
      ),
      'working: reproducing\nblocked: waiting for CI token\n',
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      cardOf({
        home,
        task: 'hotfix-2',
      }).attention.map(a => [
        a.kind,
        a.key,
      ]),
      [
        [
          'blocked',
          'default',
        ],
      ],
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
      rows.findIndex(l => l.startsWith('- [ ] hotfix-2')),
      1,
    )
    rows.splice(
      rows.indexOf('## Done') + 1,
      0,
      row!.replace(
        '[ ]',
        '[x]',
      ),
    )
    writeFileSync(
      backlog,
      rows.join('\n'),
    )
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
      {
        state: 'done',
        source: 'firstmate',
      },
    )
    assert.equal(
      hotfix.column,
      columnId({ role: 'done' }),
    )
  },
)

test(
  'a done declaration neither moves Hydra work nor closes its backlog record',
  () => {
    const { home } = copyFixture()
    const backlog = join(
      home,
      'data',
      'backlog.md',
    )
    const rows = readFileSync(
      backlog,
      'utf8',
    ).split('\n')
    const scout = rows.findIndex(l => l.startsWith('- [x] docs-scout'))
    const [row] = rows.splice(
      scout,
      1,
    )
    rows.splice(
      rows.indexOf('## In flight') + 1,
      0,
      row!.replace(
        '[x]',
        '[ ]',
      ),
    )
    writeFileSync(
      backlog,
      rows.join('\n'),
    )
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
      }).status?.state,
      'done',
    )
    assert.equal(
      cardOf({
        home,
        task: 'docs-scout',
      }).column,
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
    assert.equal(
      archived.project,
      before.project,
    )
    assert.equal(
      archived.folder,
      undefined,
    )
    assert.deepEqual(
      archived.attention,
      [],
    )
    assert.deepEqual(
      archived.outcome,
      {
        state: 'done',
        source: 'firstmate',
      },
    )
    assert.equal(
      archived.status?.state,
      'done',
    )
    assert.equal(
      archived.column,
      columnId({ role: 'done' }),
    )
    const move = readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.moved' && e.cardId === archived.id)
      .at(-1)
    assert.equal(
      move?.reason,
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
      rows.findIndex(line => line.startsWith('- [ ] hotfix-2')),
      1,
    )
    const closed = row!.replace(
      '[ ]',
      '[x]',
    )
    rows.splice(
      rows.indexOf('## Done') + 1,
      0,
      closed,
    )
    writeFileSync(
      backlog,
      rows.join('\n'),
    )
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

    writeFileSync(
      backlog,
      rows.filter(line => line !== closed).join('\n'),
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
      archived.activity,
      before.activity,
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
      const move = readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.moved' && e.cardId === api.id)
        .at(-1)
      assert.equal(
        move?.reason,
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
    const { home } = copyFixture()
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
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).links[0]!.state,
      'open',
    )
    const api = cardOf({
      home,
      task: 'api-v2',
    })
    execFileSync(
      process.execPath,
      [
        BIN,
        'link',
        api.id,
        '--url',
        'https://github.com/example/app/pull/41',
        '--state',
        'closed',
      ],
      {
        env: process.env,
      },
    )
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
        home: home,
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
    assert.equal(
      api.project,
      'app',
    )
  },
)

test(
  'watch reconciles on start and folds each change',
  async () => {
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
      ],
      code: 'VALIDATION_ERROR',
    })
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
      execFileSync(
        process.execPath,
        [
          BIN,
          'hydra',
          'set',
          '--hydra',
          'default',
          '--firstmate',
          home,
        ],
        {
          env,
          encoding: 'utf8',
        },
      )

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
    run({
      args: [
        'firstmate',
        'sync',
        '--home',
        home,
      ],
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
        '--clear',
      ],
      code: 'SOURCE_OWNED',
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
    run({
      args: [
        'firstmate',
        'sync',
        '--home',
        home,
      ],
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
    run({
      args: [
        'firstmate',
        'sync',
        '--home',
        home,
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
    const moved = readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.moved')
      .at(-1)!
    assert.equal(
      moved.reason,
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
    const columns = Object.fromEntries([
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
      columns,
      {
        'held-1': 'needs_you',
        'held-2': 'parked',
        'held-3': 'parked',
        'held-4': 'parked',
        'held-5': 'parked',
        'held-6': 'queued',
      },
    )
    const reasons = readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.moved' && e.cardId === cardOf({
      home,
      task: 'held-2',
    }).id)
    assert.equal(
      reasons[0]?.reason,
      'Held in the Firstmate backlog until 2026-11-08',
    )
  },
)

test(
  'a Firstmate Hydra on the older layout moves onto the default columns, placing cards by status',
  () => {
    const { home } = copyFixture()
    const dir = join(
      process.env.PNYX_HOME!,
      'hydras',
      'default',
    )
    mkdirSync(
      dir,
      { recursive: true },
    )
    const legacy = [
      {
        id: 'needs_you',
        title: 'Needs you',
        role: 'needs_you',
      },
      {
        id: 'workers_on_it',
        title: 'Workers on it',
        role: 'workers_on_it',
      },
      {
        id: 'done',
        title: 'Done',
        role: 'done',
      },
      {
        id: 'custom:x',
        title: 'Mine',
      },
    ]
    const base = {
      v: 1,
      at: '2026-10-01T00:00:00.000Z',
      actor: 'cli',
    }
    const events = [
      {
        ...base,
        seq: 1,
        id: 'evt_1',
        cardId: '$board',
        type: 'board.configured',
        data: {
          id: 'default',
          name: 'default',
          hydra: {
            id: homeKey({ home }),
            name: 'Hydra',
            kind: 'firstmate',
            home,
          },
          columns: legacy,
        },
      },
      {
        ...base,
        seq: 2,
        id: 'evt_2',
        cardId: 'c1',
        type: 'card.pushed',
        data: {
          key: 'old-done',
          title: 'Old done',
        },
      },
      {
        ...base,
        seq: 3,
        id: 'evt_3',
        cardId: 'c1',
        type: 'task.declared',
        data: {
          state: 'done',
          note: 'Finished',
        },
      },
      {
        ...base,
        seq: 4,
        id: 'evt_4',
        cardId: 'c2',
        type: 'card.pushed',
        data: {
          key: 'old-paused',
          title: 'Old paused',
        },
      },
      {
        ...base,
        seq: 5,
        id: 'evt_5',
        cardId: 'c2',
        type: 'task.declared',
        data: {
          state: 'paused',
          note: 'Later',
        },
      },
      {
        ...base,
        seq: 6,
        id: 'evt_6',
        cardId: 'c3',
        type: 'card.pushed',
        data: {
          key: 'old-mine',
          title: 'Old mine',
        },
      },
      {
        ...base,
        seq: 7,
        id: 'evt_7',
        cardId: 'c3',
        type: 'card.moved',
        data: {
          before: 'workers_on_it',
          after: 'custom:x',
        },
      },
    ]
    writeFileSync(
      join(
        dir,
        'events.jsonl',
      ),
      events.map(e => `${JSON.stringify(e)}\n`).join(''),
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards.c1!.column,
      'workers_on_it',
      'loading alone rewrites nothing',
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    const { state } = loadHydra({ hydraId: 'default' })
    assert.deepEqual(
      state.config!.columns.map(c => c.id),
      [
        'queued',
        'in_progress',
        'needs_you',
        'parked',
        'done',
        'custom:x',
      ],
    )
    assert.deepEqual(
      [
        'c1',
        'c2',
        'c3',
      ].map(id => state.cards[id]!.column),
      [
        'done',
        'parked',
        'custom:x',
      ],
    )
    const migration = readEvents({ hydraId: 'default' }).find(e => e.type === 'board.columns')!
    assert.equal(
      migration.reason,
      'Moved onto the default Hydra columns',
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
    const {
      run,
      fails,
    } = cli({ env })
    run({
      args: [
        'firstmate',
        'sync',
        '--home',
        home,
      ],
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
    appendFileSync(
      join(
        home,
        'state',
        'api-v2.status',
      ),
      'resolved [key=api-shape] [at=1791900700]: REST\n',
    )
    assert.match(
      run({
        args: [
          'firstmate',
          'sync',
          '--home',
          home,
        ],
      }),
      /home,5,3$/m,
    )
    assert.match(
      run({
        args: [
          'firstmate',
          'sync',
          '--home',
          home,
        ],
      }),
      /home,5,0$/m,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'partners',
          'page',
        ],
      }),
      /^ {6}note,"[^"]+","…Ship the v2 API so \[partners\] can \[page\]/m,
    )
    fails({
      args: [
        'undo',
        readEvents({ hydraId: 'default' }).find(e => e.type === 'card.noted')!.id,
      ],
      code: 'NOT_UNDOABLE',
    })
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
      rows.findIndex(l => l.startsWith('- [x] docs-scout')),
      1,
    )
    rows.splice(
      rows.indexOf('## In flight') + 1,
      0,
      row!.replace(
        '[x]',
        '[ ]',
      ),
    )
    writeFileSync(
      backlog,
      rows.join('\n'),
    )
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
    const cleared = readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.outcome')
      .at(-1)!
    cli({ env: process.env }).fails({
      args: [
        'undo',
        cleared.id,
      ],
      code: 'NOT_UNDOABLE',
    })
    assert.deepEqual(
      syncHome({
        hydraId: 'default',
        home,
      }).appended,
      0,
    )
  },
)

test(
  'firstmate sync ingests the hook spool',
  () => {
    const { home } = copyFixture()
    spoolWrite({
      hydraId: 'default',
      entry: {
        id: 's1',
        key: 'spooled',
        at: '2026-01-01T00:00:00.000Z',
        card: { title: 'from a hook' },
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[loadHydra({ hydraId: 'default' }).state.keys['spooled']!]!.title,
      'from a hook',
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
    run({
      args: [
        'firstmate',
        'sync',
        '--home',
        home,
      ],
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

    const out = run({
      args: [
        'reply',
        api.id,
        '--text',
        'Use REST',
        '--resolve-key',
        'api-shape',
        '--idempotency-key',
        'k1',
        '--home',
        home,
      ],
    })
    assert.match(
      out,
      /state: delivered/,
    )
    assert.equal(
      sent(),
      `FM_HOME=${home}\narg=api-v2\narg=--resolve-key\narg=api-shape\narg=Use REST\n---\n`,
    )
    assert.match(
      run({
        args: [
          'reply',
          api.id,
          '--text',
          'Use REST',
          '--idempotency-key',
          'k1',
          '--home',
          home,
        ],
      }),
      /sent: false/,
    )
    assert.equal(
      sent().split('---').length,
      2,
    )
    const decisions = readEvents({ hydraId: 'default' }).filter(event => event.type === 'card.replied' && event.data.reply === 'k1' && event.data.state === 'delivered')
    assert.equal(
      decisions.length,
      1,
    )
    const delivered = decisions[0]
    assert.ok(delivered?.type === 'card.replied')
    assert.deepEqual(
      delivered.data.decision,
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

    writeFileSync(
      join(
        home,
        'send-exit',
      ),
      '2',
    )
    assert.match(
      run({
        args: [
          'reply',
          api.id,
          '--text',
          'ping',
          '--idempotency-key',
          'k2',
          '--home',
          home,
        ],
      }),
      /state: failed/,
    )
    writeFileSync(
      join(
        home,
        'send-exit',
      ),
      '0',
    )
    assert.match(
      run({
        args: [
          'reply',
          api.id,
          '--text',
          'ping',
          '--idempotency-key',
          'k2',
          '--home',
          home,
        ],
      }),
      /state: delivered/,
    )
    writeFileSync(
      join(
        home,
        'send-exit',
      ),
      '3',
    )
    assert.match(
      run({
        args: [
          'reply',
          api.id,
          '--text',
          'maybe',
          '--idempotency-key',
          'k3',
          '--home',
          home,
        ],
      }),
      /state: delivery_unknown/,
    )
    assert.match(
      run({
        args: [
          'reply',
          api.id,
          '--text',
          'maybe',
          '--idempotency-key',
          'k3',
          '--home',
          home,
        ],
      }),
      /sent: false/,
    )
    // Exit 1 (a remote send that lost its transport) may also have landed.
    writeFileSync(
      join(
        home,
        'send-exit',
      ),
      '1',
    )
    const unknown = run({
      args: [
        'reply',
        api.id,
        '--text',
        'remote',
        '--idempotency-key',
        'k4',
        '--home',
        home,
      ],
    })
    assert.match(
      unknown,
      /state: delivery_unknown/,
    )
    assert.match(
      unknown,
      /may have landed/,
    )
    assert.doesNotMatch(
      unknown,
      /retry with --idempotency-key/,
    )
    assert.match(
      run({
        args: [
          'reply',
          api.id,
          '--text',
          'remote',
          '--idempotency-key',
          'k4',
          '--home',
          home,
        ],
      }),
      /sent: false/,
    )

    const history = run({
      args: [
        'history',
        '--card',
        api.id,
        '--kind',
        'replied',
        '--limit',
        '100',
      ],
    })
    assert.equal(
      history.match(/reply k2 /g)?.length,
      4,
    )
    assert.match(
      history,
      /reply k1 delivered/,
    )
    assert.match(
      history,
      /reply k3 delivery_unknown/,
    )

    // The send went through but its outcome could not be recorded: the receipt still
    // names the reply, and a retry finds it queued and does not resend.
    writeFileSync(
      join(
        home,
        'send-exit',
      ),
      '0',
    )
    writeFileSync(
      join(
        home,
        'tear',
      ),
      '',
    )
    const unrecorded = run({
      args: [
        'reply',
        api.id,
        '--text',
        'torn',
        '--home',
        home,
      ],
    })
    assert.match(
      unrecorded,
      /state: delivered/,
    )
    assert.match(
      unrecorded,
      /recordError: /,
    )
    const id = /reply: (r\d+)/.exec(unrecorded)![1]!
    rmSync(join(
      home,
      'tear',
    ))
    run({ args: ['repair'] })
    const retry = run({
      args: [
        'reply',
        api.id,
        '--text',
        'torn',
        '--idempotency-key',
        id,
        '--home',
        home,
      ],
    })
    assert.match(
      retry,
      /state: queued/,
    )
    assert.match(
      retry,
      /sent: false/,
    )
    assert.match(
      retry,
      /Check the task's inbox/,
    )
    assert.equal(
      sent().split('---').length - 1,
      6,
    )
    // A known failure that could not be recorded says nothing was delivered.
    writeFileSync(
      join(
        home,
        'send-exit',
      ),
      '2',
    )
    writeFileSync(
      join(
        home,
        'tear',
      ),
      '',
    )
    const lost = run({
      args: [
        'reply',
        api.id,
        '--text',
        'lost',
        '--home',
        home,
      ],
    })
    assert.match(
      lost,
      /state: failed/,
    )
    assert.match(
      lost,
      /nothing was delivered/,
    )
    rmSync(join(
      home,
      'tear',
    ))
    run({ args: ['repair'] })

    fails({
      args: [
        'reply',
        api.id,
        '--text',
        'x',
        '--resolve-key',
        'nope',
        '--home',
        home,
      ],
      code: 'VALIDATION_ERROR',
    })
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
    fails({
      args: [
        'reply',
        cardOf({ home }).id,
        '--text',
        'x',
        '--home',
        home,
      ],
      code: 'NO_ROUTE',
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
        'undo',
        readEvents({ hydraId: 'default' }).find(e => e.type === 'card.replied')!.id,
      ],
      code: 'NOT_UNDOABLE',
    })
    const other = copyFixture()
    fails({
      args: [
        'reply',
        api.id,
        '--text',
        'x',
        '--home',
        other.home,
      ],
      code: 'VALIDATION_ERROR',
    })
  },
)

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
    const hook = ({
      id,
      event,
      payload,
      extra = {},
    }: {
      id: string
      event: string
      payload: Record<string, unknown>
      extra?: Record<string, unknown>
    }) =>
      spoolWrite({
        hydraId: 'default',
        entry: {
          v: 1,
          id,
          at: '2026-10-14T00:00:00Z',
          harness: 'claude',
          event,
          payload,
          ...extra,
        },
      })
    const terminal = {
      tty: '/dev/ttys042',
      pid: '4242',
      program: 'tmux',
      tmux: '/tmp/tmux-1/default',
      tmuxPane: '%3',
    }
    // The hook reports the folder as the session saw it; the join compares canonical paths.
    hook({
      id: 'h1',
      event: 'SessionStart',
      payload: {
        session_id: 'fm-s',
        cwd: worktree,
        transcript_path: '/x/fm-s.jsonl',
      },
      extra: { terminal },
    })
    hook({
      id: 'h2',
      event: 'SubagentStart',
      payload: {
        session_id: 'fm-s',
        agent_id: 'a1',
        cwd: worktree,
      },
    })
    syncHome({
      hydraId: 'default',
      home,
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
      state.keys['claude:fm-s'],
      undefined,
    )
    assert.equal(
      state.cards[state.keys['claude:fm-s/a1']!]!.parentId,
      api.id,
    )

    const {
      run,
      fails,
    } = cli({ env })
    assert.match(
      run({
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

    hook({
      id: 'h2a',
      event: 'PermissionRequest',
      payload: {
        session_id: 'fm-s',
        cwd: worktree,
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    syncHome({
      hydraId: 'default',
      home,
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
    fails({
      args: [
        'reply',
        api.id,
        '--text',
        'x',
        '--resolve-key',
        asks[0]!.key,
        '--home',
        home,
      ],
      code: 'VALIDATION_ERROR',
    })

    hook({
      id: 'h2e',
      event: 'SessionEnd',
      payload: {
        session_id: 'fm-s',
        cwd: worktree,
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home,
        task: 'api-v2',
      }).outcome,
      undefined,
    )

    // A closed task gives its worktree up, so the next session there keeps its own card.
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
      rows.findIndex(l => l.startsWith('- [ ] api-v2')),
      1,
    )
    writeFileSync(
      backlog,
      [
        ...rows,
        row!.replace(
          '[ ]',
          '[x]',
        ),
      ].join('\n'),
    )
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
    hook({
      id: 'h2b',
      event: 'SubagentStop',
      payload: {
        session_id: 'fm-s',
        agent_id: 'a1',
        cwd: worktree,
      },
    })
    hook({
      id: 'h2c',
      event: 'SessionEnd',
      payload: {
        session_id: 'fm-s',
        cwd: worktree,
      },
    })
    hook({
      id: 'h3',
      event: 'SessionStart',
      payload: {
        session_id: 'next',
        cwd: worktree,
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.keys['claude:fm-s'],
      undefined,
    )
    assert.ok(loadHydra({ hydraId: 'default' }).state.keys['claude:next'])
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
    const meta = ({
      task,
      terminal,
    }: {
      task: string
      terminal: string
    }) =>
      writeFileSync(
        join(
          home,
          'state',
          `${task}.meta`,
        ),
        `task=${task}\nkind=ship\nworktree=${worktree}\npaseo_terminal_id=${terminal}\n`,
      )
    const tty = {
      tty: '/dev/ttys042',
      pid: '4242',
    }
    const hook = ({
      id,
      session,
      paseoTerminal,
      facts = tty,
      extra = {},
    }: {
      id: string
      session: string
      paseoTerminal?: string
      facts?: object
      extra?: object
    }) =>
      spoolWrite({
        hydraId: 'default',
        entry: {
          v: 1,
          id,
          at: '2026-10-14T00:00:00Z',
          harness: 'claude',
          event: 'SessionStart',
          payload: {
            session_id: session,
            cwd: worktree,
            ...extra,
          },
          terminal: {
            ...facts,
            program: 'kitty',
            ...(paseoTerminal ? { paseoTerminal } : {}),
          },
        },
      })
    const own = ({ session }: { session: string }) => !!loadHydra({ hydraId: 'default' }).state.keys[`claude:${session}`]

    // The pool hands the worktree from a finished task, whose records are gone, to the next.
    meta({
      task: 'wt-a',
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
    meta({
      task: 'wt-b',
      terminal: 'term-b',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      cardOf({
        home: home,
        task: 'wt-b',
      }).terminal,
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
    hook({
      id: 'h1',
      session: 's-b',
      paseoTerminal: 'term-b',
      extra: { transcript_path: transcript },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-b',
      }).agent?.sessionId,
      's-b',
    )
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-b',
      }).terminal?.pid,
      '4242',
    )
    assert.equal(
      own({ session: 's-b' }),
      false,
    )

    // A second session in the folder, in another or an unknown terminal, never replaces it.
    hook({
      id: 'h2',
      session: 's-twin',
      paseoTerminal: 'term-elsewhere',
    })
    hook({
      id: 'h2b',
      session: 's-bare',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-b',
      }).agent?.sessionId,
      's-b',
    )
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-b',
      }).terminal?.pid,
      '4242',
    )
    assert.equal(
      own({ session: 's-twin' }),
      true,
    )
    assert.equal(
      own({ session: 's-bare' }),
      true,
    )

    // A headless run the worker starts in its worktree inherits the task's terminal
    // but has no tty of its own, so it keeps its own card.
    hook({
      id: 'h2h',
      session: 's-child',
      paseoTerminal: 'term-b',
      facts: {},
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-b',
      }).agent?.sessionId,
      's-b',
    )
    assert.equal(
      own({ session: 's-child' }),
      true,
    )

    // Claude Code's /clear starts a new session on the same tty, which continues the
    // card, and its later events reach it.
    hook({
      id: 'h2c',
      session: 's-b2',
      paseoTerminal: 'term-b',
      facts: tty,
      extra: { source: 'clear' },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    hook({
      id: 'h2d',
      session: 's-b2',
      paseoTerminal: 'term-b',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-b',
      }).agent?.sessionId,
      's-b2',
    )
    assert.equal(
      own({ session: 's-b2' }),
      false,
    )
    const continued = loadHydra({ hydraId: 'default' }).state
    assert.equal(
      continued.sessions?.['claude-code:s-b']?.taskId,
      null,
    )
    assert.equal(
      continued.sessions?.['claude-code:s-b2']?.taskId,
      cardOf({
        home,
        task: 'wt-b',
      }).id,
    )
    assert.deepEqual(
      cardOf({
        home,
        task: 'wt-b',
      }).sessionIds,
      ['claude-code:s-b2'],
    )
    rmSync(transcript)
    assert.ok(readEvents({ hydraId: 'default' }).some(e => e.type === 'chat.message'
    && e.data.session === 'claude-code:s-b' && e.data.text === 'Retain before clear'))

    hook({
      id: 'h2s',
      session: 's-b',
      paseoTerminal: 'term-b',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-b',
      }).agent?.sessionId,
      's-b2',
    )
    assert.equal(
      own({ session: 's-b' }),
      true,
    )

    meta({
      task: 'wt-b',
      terminal: 'term-b3',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      cardOf({
        home: home,
        task: 'wt-b',
      }).terminal,
      { paseoTerminal: 'term-b3' },
    )
    hook({
      id: 'h2e',
      session: 's-b3',
      paseoTerminal: 'term-b3',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-b',
      }).agent?.sessionId,
      's-b3',
    )
    assert.equal(
      own({ session: 's-b3' }),
      false,
    )

    // Follow-up tasks launched into the same worktree: each session's own Paseo
    // terminal tells them apart, and one launched elsewhere joins neither.
    meta({
      task: 'wt-c',
      terminal: 'term-c0',
    })
    meta({
      task: 'wt-d',
      terminal: 'term-d',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    meta({
      task: 'wt-c',
      terminal: 'term-c',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.deepEqual(
      cardOf({
        home: home,
        task: 'wt-c',
      }).terminal,
      { paseoTerminal: 'term-c' },
    )
    // A headless child in the task's terminal never joins a task card with no session yet.
    hook({
      id: 'h3h',
      session: 's-d-child',
      paseoTerminal: 'term-d',
      facts: {},
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-d',
      }).agent,
      undefined,
    )
    assert.equal(
      own({ session: 's-d-child' }),
      true,
    )
    hook({
      id: 'h3',
      session: 's-d',
      paseoTerminal: 'term-d',
    })
    hook({
      id: 'h4',
      session: 's-other',
      paseoTerminal: 'term-elsewhere',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-d',
      }).agent?.sessionId,
      's-d',
    )
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-c',
      }).agent,
      undefined,
    )
    assert.equal(
      own({ session: 's-other' }),
      true,
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
    writeFileSync(
      join(
        home,
        'state',
        'wt-t.meta',
      ),
      `task=wt-t\nkind=ship\nworktree=${worktree}\n`,
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h1',
        at: '2026-10-14T00:00:00Z',
        harness: 'claude',
        event: 'SessionStart',
        payload: {
          session_id: 's-tmux',
          cwd: worktree,
        },
        terminal: {
          tty: '/dev/ttys042',
          pid: '4242',
          program: 'tmux',
        },
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })

    assert.equal(
      cardOf({
        home: home,
        task: 'wt-t',
      }).agent?.sessionId,
      's-tmux',
    )
    assert.deepEqual(
      cardOf({
        home: home,
        task: 'wt-t',
      }).terminal,
      {
        tty: '/dev/ttys042',
        pid: '4242',
        program: 'tmux',
      },
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
  'a task launched in a Paseo terminal takes only a session from that terminal',
  () => {
    const { home } = copyFixture()
    const worktree = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-wt-',
    )))
    writeFileSync(
      join(
        home,
        'state',
        'wt-p.meta',
      ),
      `task=wt-p\nkind=ship\nworktree=${worktree}\npaseo_terminal_id=term-p\n`,
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    const start = ({
      id,
      session,
      terminal,
    }: {
      id: string
      session: string
      terminal: object
    }) =>
      spoolWrite({
        hydraId: 'default',
        entry: {
          v: 1,
          id,
          at: '2026-10-14T00:00:00Z',
          harness: 'claude',
          event: 'SessionStart',
          payload: {
            session_id: session,
            cwd: worktree,
          },
          terminal,
        },
      })

    start({
      id: 'h1',
      session: 's-tmux',
      terminal: {
        tty: '/dev/ttys042',
        pid: '4242',
        program: 'tmux',
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-p',
      }).agent,
      undefined,
    )
    assert.deepEqual(
      cardOf({
        home: home,
        task: 'wt-p',
      }).terminal,
      { paseoTerminal: 'term-p' },
    )
    assert.ok(loadHydra({ hydraId: 'default' }).state.keys['claude:s-tmux'])

    start({
      id: 'h2',
      session: 's-worker',
      terminal: {
        tty: '/dev/ttys043',
        pid: '4343',
        program: 'kitty',
        paseoTerminal: 'term-p',
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-p',
      }).agent?.sessionId,
      's-worker',
    )
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-p',
      }).terminal?.paseoTerminal,
      'term-p',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.keys['claude:s-worker'],
      undefined,
    )
  },
)

test(
  'a Paseo task takes only events from its terminal, whatever event comes first',
  () => {
    const { home } = copyFixture()
    const worktree = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-wt-',
    )))
    writeFileSync(
      join(
        home,
        'state',
        'wt-q.meta',
      ),
      `task=wt-q\nkind=ship\nworktree=${worktree}\npaseo_terminal_id=term-q\n`,
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    const hook = ({
      id,
      session,
      event,
      terminal,
    }: {
      id: string
      session: string
      event: string
      terminal?: object
    }) =>
      spoolWrite({
        hydraId: 'default',
        entry: {
          v: 1,
          id,
          at: '2026-10-14T00:00:00Z',
          harness: 'codex',
          event,
          payload: {
            session_id: session,
            cwd: worktree,
            tool_name: 'Bash',
            tool_input: { command: 'ls' },
            prompt: 'x',
          },
          ...(terminal ? { terminal } : {}),
        },
      })
    const own = ({ session }: { session: string }) => !!loadHydra({ hydraId: 'default' }).state.keys[`codex:${session}`]

    hook({
      id: 'h1',
      session: 's-other',
      event: 'SessionStart',
      terminal: {
        tty: '/dev/ttys050',
        pid: '5050',
        paseoTerminal: 'term-elsewhere',
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-q',
      }).agent,
      undefined,
    )
    assert.equal(
      own({ session: 's-other' }),
      true,
    )

    hook({
      id: 'h1b',
      session: 's-bare',
      event: 'PreToolUse',
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-q',
      }).agent,
      undefined,
    )
    assert.equal(
      own({ session: 's-bare' }),
      true,
    )

    // A worker already running when its hooks were trusted first reports a tool call,
    // which shows only its Paseo terminal; it joins, and its later events follow.
    hook({
      id: 'h2',
      session: 's-worker',
      event: 'PreToolUse',
      terminal: { paseoTerminal: 'term-q' },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-q',
      }).agent?.sessionId,
      's-worker',
    )
    assert.deepEqual(
      cardOf({
        home: home,
        task: 'wt-q',
      }).terminal,
      { paseoTerminal: 'term-q' },
    )
    assert.equal(
      own({ session: 's-worker' }),
      false,
    )
    hook({
      id: 'h3',
      session: 's-worker',
      event: 'UserPromptSubmit',
      terminal: {
        tty: '/dev/ttys051',
        pid: '5151',
        paseoTerminal: 'term-q',
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-q',
      }).agent?.sessionId,
      's-worker',
    )
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-q',
      }).terminal?.paseoTerminal,
      'term-q',
    )
    assert.equal(
      own({ session: 's-worker' }),
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
    writeFileSync(
      join(
        home,
        'state',
        'wt-r.meta',
      ),
      `task=wt-r\nkind=ship\nworktree=${worktree}\npaseo_terminal_id=term-r\n`,
    )
    syncHome({
      hydraId: 'default',
      home,
    })
    const hook = ({
      id,
      session,
      event,
      terminal,
    }: {
      id: string
      session: string
      event: string
      terminal: object
    }) =>
      spoolWrite({
        hydraId: 'default',
        entry: {
          v: 1,
          id,
          at: '2026-10-14T00:00:00Z',
          harness: 'codex',
          event,
          payload: {
            session_id: session,
            cwd: worktree,
            prompt: 'x',
          },
          terminal,
        },
      })
    const own = ({ session }: { session: string }) => !!loadHydra({ hydraId: 'default' }).state.keys[`codex:${session}`]

    hook({
      id: 'h1',
      session: 's-a',
      event: 'PreToolUse',
      terminal: { paseoTerminal: 'term-r' },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-r',
      }).agent?.sessionId,
      's-a',
    )

    hook({
      id: 'h2',
      session: 's-a',
      event: 'UserPromptSubmit',
      terminal: {
        tty: '/dev/ttys060',
        pid: '6060',
        program: 'tmux',
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      own({ session: 's-a' }),
      true,
    )
    assert.deepEqual(
      cardOf({
        home: home,
        task: 'wt-r',
      }).terminal,
      { paseoTerminal: 'term-r' },
    )

    hook({
      id: 'h3',
      session: 's-worker',
      event: 'SessionStart',
      terminal: {
        tty: '/dev/ttys061',
        pid: '6161',
        paseoTerminal: 'term-r',
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.equal(
      cardOf({
        home: home,
        task: 'wt-r',
      }).agent?.sessionId,
      's-worker',
    )
    assert.equal(
      own({ session: 's-worker' }),
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
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h1',
        at: '2026-10-14T00:00:00Z',
        harness: 'claude',
        event: 'SessionStart',
        terminal: {
          tty: '/dev/ttys042',
          pid: '4242',
        },
        payload: {
          session_id: 'fm-s',
          cwd: worktree,
          model: 'claude-sonnet-5-5',
        },
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    const api = cardOf({
      home: home,
      task: 'api-v2',
    })
    const { run } = cli({ env: env })
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

    assert.match(
      run({
        args: [
          'agent',
          api.id,
          '--home',
          home,
        ],
      }),
      /route: "firstmate:inbox"[\s\S]*mode,unknown,next,yes/,
    )
    assert.match(
      run({
        args: [
          'agent',
          api.id,
          'model',
          'opus',
          '--home',
          home,
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
    run({
      args: [
        'agent',
        api.id,
        'model',
        'opus',
        '--home',
        home,
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
      run({
        args: [
          'agent',
          api.id,
          'mode',
          'next',
          '--home',
          home,
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

    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h3',
        at: '2026-10-14T00:02:00Z',
        harness: 'claude',
        event: 'UserPromptSubmit',
        terminal: {
          tty: '/dev/ttys042',
          pid: '4242',
        },
        payload: {
          session_id: 'fm-s',
          cwd: worktree,
          prompt: 'x',
          permission_mode: 'acceptEdits',
        },
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    assert.match(
      run({
        args: [
          'agent',
          api.id,
          '--home',
          home,
        ],
      }),
      /mode,acceptEdits,next,yes/,
    )

    // A note saved but not announced may still reach the orchestrator; one not saved fails.
    writeFileSync(
      join(
        home,
        'inbox-exit',
      ),
      '3',
    )
    assert.match(
      run({
        args: [
          'agent',
          api.id,
          'effort',
          'high',
          '--home',
          home,
          '--idempotency-key',
          'm3',
        ],
      }),
      /sent: delivery_unknown[\s\S]*fm-inbox.sh announce n3/,
    )
    writeFileSync(
      join(
        home,
        'inbox-exit',
      ),
      '1',
    )
    assert.match(
      run({
        args: [
          'agent',
          api.id,
          'fast',
          'on',
          '--home',
          home,
          '--idempotency-key',
          'm4',
        ],
      }),
      /sent: failed[\s\S]*Nothing was changed: fm-inbox: fake note failed/,
    )
    writeFileSync(
      join(
        home,
        'inbox-exit',
      ),
      '0',
    )

    writeFileSync(
      meta,
      `${readFileSync(
        meta,
        'utf8',
      ).replace(
        /^kind=.*$/m,
        'kind=secondmate',
      )}remote_host=box\n`,
    )
    assert.match(
      run({
        args: [
          'agent',
          api.id,
          'effort',
          'low',
          '--home',
          home,
          '--idempotency-key',
          'm5',
        ],
      }),
      /sent: delivered/,
    )

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
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h4',
        at: '2026-10-14T00:00:00Z',
        harness: 'codex',
        event: 'SessionStart',
        terminal: {
          tty: '/dev/ttys043',
          pid: '4343',
        },
        payload: {
          session_id: 'cx-s',
          cwd: codexTree,
        },
      },
    })
    syncHome({
      hydraId: 'default',
      home,
    })
    const hotfix = cardOf({
      home: home,
      task: 'hotfix-2',
    })
    assert.equal(
      hotfix.agent?.provider,
      'codex',
    )
    assert.match(
      run({
        args: [
          'agent',
          hotfix.id,
          '--home',
          home,
        ],
      }),
      /model,unknown,gpt-6.1-sol gpt-6-astra gpt-6-sol gpt-6-luna,yes/,
    )
    assert.match(
      run({
        args: [
          'agent',
          hotfix.id,
          '--home',
          home,
        ],
      }),
      /approval,unknown,untrusted on-request never,yes/,
    )
    assert.match(
      run({
        args: [
          'agent',
          hotfix.id,
          'model',
          'gpt-6.1-sol',
          '--home',
          home,
          '--idempotency-key',
          'cx-model',
        ],
      }),
      /sent: delivered[\s\S]*confirmed: false/,
    )
    assert.match(
      notes().at(-1)!,
      /arg=Pnyx: please switch the worker on task hotfix-2 \(Codex\) to model gpt-6.1-sol\.\n$/,
    )
    const count = notes().length
    run({
      args: [
        'agent',
        hotfix.id,
        'model',
        'gpt-6.1-sol',
        '--home',
        home,
        '--idempotency-key',
        'cx-model',
      ],
    })
    assert.equal(
      notes().length,
      count,
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
    assert.match(
      run({
        args: [
          'agent',
          hotfix.id,
          'effort',
          'raise',
          '--home',
          home,
        ],
      }),
      /sent: delivered/,
    )
    assert.match(
      notes().at(-1)!,
      /arg=Pnyx: please raise the reasoning effort of the worker on task hotfix-2 \(Codex\) by one step\.\n$/,
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
    const { run } = cli({ env })
    run({
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
