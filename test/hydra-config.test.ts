import { fixtureCli } from '../src/test-harness/cli-fixture.ts'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { spoolWrite } from '../src/app/spool.ts'
import { hydraDir } from '../src/app/home-migration.ts'
import { DEFAULT_COLUMNS, lockedColumn, migrateColumns } from '../src/core/hydra.ts'
import { decideUndo } from '../src/app/undo.ts'
import { HydraError, type HydraColumn, type Card } from '../src/core/model.ts'
import { type HydraState } from '../src/app/model.ts'
import { emptyHydra, reduce } from '../src/app/reducer.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)

function hydraId() {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-hydra-',
  ))
  const env = {
    ...process.env,
    PNYX_HOME: home,
  }

  const execute = fixtureCli({
    home,
    execute: ({ args }) => execFileSync(
      process.execPath,
      [
        BIN,
        ...args,
      ],
      {
        env,
        encoding: 'utf8',
      },
    ),
  })

  const run = ({ args }: { args: string[] }): string => {
    const out = execute({ args })
    const token = /^token: ([a-f0-9]+)$/m.exec(out)?.[1]

    return token ? run({
      args: [
        ...args,
        '--confirm',
        token,
      ],
    }) : out
  }

  const fails = ({
    args,
    status,
    code,
  }: {
    args: string[]
    status: number
    code: string
  }) =>
    assert.throws(
      () => run({ args: [...args] }),
      (error: {
        status: number
        stdout: string
      }) => {
        assert.equal(
          error.status,
          status,
        )
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

  const card = ({ json }: { json: object }) => {
    const file = join(
      home,
      `card-${Math.random()}.json`,
    )
    writeFileSync(
      file,
      JSON.stringify(json),
    )

    return file
  }

  return {
    home,
    env,
    run,
    fails,
    card,
    execute,
    state: () => (JSON.parse(readFileSync(
      join(
        home,
        'hydras/default/snapshot.json',
      ),
      'utf8',
    )) as { state: HydraState }).state,
  }
}

test(
  'column rules require confirmation, preview affected cards, and persist through replay and undo',
  t => {
    const f = hydraId()
    const role = ({ name }: { name: string }) =>
      f.state().config!.columns.find(column => column.role === name)!.id
    t.after(() => rmSync(
      f.home,
      {
        recursive: true,
        force: true,
      },
    ))
    f.run({
      args: [
        'hydra',
        'create',
        'default',
      ],
    })
    f.run({
      args: [
        'task',
        'create',
        '--title',
        'Research',
        '--key',
        'research',
        '--kind',
        'investigation',
      ],
    })
    f.run({
      args: [
        'column',
        'create',
        '--id',
        'custom:research',
        '--title',
        'Research',
      ],
    })
    f.run({
      args: [
        'column',
        'reorder',
        'custom:research',
        '--before',
        role({ name: 'queued' }),
      ],
    })
    const id = f.state().keys.research!
    const command = [
      'column',
      'rule',
      'custom:research',
      '--when',
      'kind:investigation,!done,!owner-question',
      '--when',
      'pr:green,!pr:draft',
      '--reason',
      'Research gets its own column',
    ]
    const preview = f.execute({ args: command })
    assert.match(
      preview,
      /^confirmation: needed$/m,
    )
    assert.match(
      preview,
      /affectedCards: 1/,
    )
    assert.match(
      preview,
      /kind:investigation/,
    )
    assert.equal(
      f.state().cards[id]!.column,
      role({ name: 'queued' }),
    )
    const token = /^token: (\S+)$/m.exec(preview)![1]!
    const stale = f.execute({
      args: [
        ...command,
        '--when',
        'held',
        '--confirm',
        token,
      ],
    })
    assert.match(
      stale,
      /^confirmation: needed$/m,
    )
    assert.equal(
      f.state().cards[id]!.column,
      role({ name: 'queued' }),
    )
    const output = f.execute({
      args: [
        ...command,
        '--confirm',
        token,
      ],
    })
    assert.equal(
      f.state().cards[id]!.column,
      'custom:research',
    )
    assert.deepEqual(
      f.state().config!.columns[0]!.rule,
      [
        [
          'kind:investigation',
          '!done',
          '!owner-question',
        ],
        [
          'pr:green',
          '!pr:draft',
        ],
      ],
    )
    assert.match(
      f.run({
        args: [
          'column',
          'list',
        ],
      }),
      /kind:investigation/,
    )
    assert.match(
      f.run({
        args: [
          'hydra',
          'digest',
        ],
      }),
      /kind:investigation AND !done AND !owner-question OR pr:green AND !pr:draft/,
    )
    const events = readFileSync(
      join(
        f.home,
        'hydras/default/events.jsonl',
      ),
      'utf8',
    ).trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const replayed = events.reduce(
      (
        state: HydraState,
        event,
      ) => reduce({
        state,
        event,
      }),
      emptyHydra(),
    )
    assert.deepEqual(
      replayed.cards[id],
      f.state().cards[id],
    )
    assert.deepEqual(
      replayed.config!.columns,
      f.state().config!.columns,
    )
    const ruleEvent = /^ {2}id: (\S+)$/m.exec(output)![1]!
    f.run({
      args: [
        'undo',
        ruleEvent,
      ],
    })
    assert.equal(
      f.state().cards[id]!.column,
      role({ name: 'queued' }),
    )
    assert.deepEqual(
      f.state().config!.columns[0]!.rule,
      [],
    )
    f.run({ args: command })
    f.run({
      args: [
        'move',
        'research',
        'parked',
        '--reason',
        'Check the findings first',
      ],
    })
    f.run({
      args: [
        'task',
        'rename',
        'research',
        '--title',
        'Research renamed',
      ],
    })
    assert.equal(
      f.state().cards[id]!.column,
      role({ name: 'parked' }),
      'a non-phase edit preserves the manual exception',
    )
    f.run({
      args: [
        'task',
        'status',
        'research',
        'working',
      ],
    })
    assert.equal(
      f.state().cards[id]!.column,
      role({ name: 'parked' }),
      'the same matching rule preserves the manual exception',
    )
    f.run({
      args: [
        'task',
        'ask',
        'research',
        '--to',
        'owner',
        '--actor',
        'hydra',
        '--reason',
        'The owner chooses the scope',
        '--question',
        'Which scope?',
      ],
    })
    assert.equal(
      f.state().cards[id]!.column,
      role({ name: 'needs_you' }),
      'an owner question changes the matching phase',
    )
    f.run({
      args: [
        'column',
        'rule',
        'custom:research',
        '--clear',
        '--reason',
        'Manual placement only',
      ],
    })
    assert.equal(
      f.state().cards[id]!.column,
      role({ name: 'needs_you' }),
    )
    assert.deepEqual(
      f.state().config!.columns[0]!.rule,
      [],
    )
    f.fails({
      args: [
        'column',
        'rule',
        'custom:research',
        '--when',
        'unknown',
        '--reason',
        'Invalid',
      ],
      status: 2,
      code: 'VALIDATION_ERROR',
    })
    f.fails({
      args: [
        'column',
        'rule',
        'custom:research',
        '--when',
        'held',
      ],
      status: 2,
      code: 'VALIDATION_ERROR',
    })
  },
)

test(
  'adding rules to an old Hydra preserves column order, names, manual cards and existing rules',
  () => {
    const columns: HydraColumn[] = [
      {
        id: 'custom:triage',
        title: 'Triage',
      },
      {
        id: 'needs_you',
        title: 'Your call',
        role: 'needs_you',
      },
      {
        id: 'in_progress',
        title: 'Building',
        role: 'in_progress',
      },
      {
        id: 'queued',
        title: 'Backlog',
        role: 'queued',
      },
      {
        id: 'parked',
        title: 'Later',
        role: 'parked',
        rule: [['held']],
      },
      {
        id: 'done',
        title: 'Landed',
        role: 'done',
      },
    ]
    const card: Card = {
      id: 'old',
      key: 'old',
      title: 'Old work',
      column: 'custom:triage',
      workspace: 'unassigned',
      tags: [],
      attention: [],
      links: [],
      sourceRefs: [],
      revision: 1,
      createdSeq: 1,
      updatedSeq: 1,
      updatedAt: '2026-10-20T00:00:00Z',
      status: {
        id: 'working',
        actor: 'worker:old',
        at: '2026-10-20T00:00:00Z',
        state: 'working',
        note: '',
      },
    }
    const state: HydraState = {
      ...emptyHydra(),
      config: {
        id: 'old',
        name: 'Old',
        hydra: {
          id: 'hydra',
          name: 'Hydra',
          kind: 'agent',
        },
        columns,
      },
      cards: {
        old: card,
        manual: {
          ...card,
          id: 'manual',
          key: 'manual',
          column: 'queued',
        },
      },
    }
    const migration = migrateColumns({
      state,
      meta: {
        actor: 'pnyx',
        at: '2026-10-23T00:00:00Z',
      },
    })
    assert.ok('event' in migration)
    const migrated = reduce({
      state,
      event: migration.event,
    })
    assert.deepEqual(
      migrated.config!.columns.map(column => [
        column.id,
        column.title,
        column.role,
      ]),
      columns.map(column => [
        column.id,
        column.title,
        column.role,
      ]),
    )
    assert.deepEqual(
      migrated.config!.columns[0]!.rule,
      [],
    )
    assert.deepEqual(
      migrated.config!.columns.find(column => column.id === 'parked')!.rule,
      [['held']],
    )
    assert.ok(migrated.config!.columns.every(column => column.rule !== undefined))
    assert.equal(
      migrated.cards.old!.column,
      'custom:triage',
    )
    assert.equal(
      migrated.cards.manual!.column,
      'queued',
    )
    assert.deepEqual(
      migrateColumns({
        state: migrated,
        meta: {
          actor: 'pnyx',
          at: '2026-10-23T01:00:00Z',
        },
      }),
      { skipped: 'unchanged' },
    )
  },
)

test(
  'the first write adds rules once without sweeping old custom or manual placements',
  t => {
    const f = hydraId()
    t.after(() => rmSync(
      f.home,
      {
        recursive: true,
        force: true,
      },
    ))
    f.run({
      args: [
        'hydra',
        'create',
        'default',
      ],
    })
    f.run({
      args: [
        'task',
        'create',
        '--key',
        'old',
        '--title',
        'Old task',
      ],
    })
    f.run({
      args: [
        'task',
        'status',
        'old',
        'working',
      ],
    })
    f.run({
      args: [
        'column',
        'create',
        '--id',
        'custom:triage',
        '--title',
        'Triage',
      ],
    })
    f.run({
      args: [
        'move',
        'old',
        'custom:triage',
      ],
    })
    f.run({
      args: [
        'task',
        'create',
        '--key',
        'manual',
        '--title',
        'Manually queued task',
      ],
    })
    f.run({
      args: [
        'task',
        'status',
        'manual',
        'working',
      ],
    })
    f.run({
      args: [
        'move',
        'manual',
        'queued',
      ],
    })
    const before = f.state()
    const logPath = join(
      f.home,
      'hydras/default/events.jsonl',
    )
    const legacy = readFileSync(
      logPath,
      'utf8',
    ).trim()
      .split('\n')
      .map(line => {
        const event = JSON.parse(line)

        for (const column of event.data.columns ?? []) {
          delete column.rule
        }

        for (const column of Array.isArray(event.data.before) ? event.data.before : []) {
          delete column.rule
        }

        return JSON.stringify(event)
      })
      .join('\n') + '\n'
    writeFileSync(
      logPath,
      legacy,
    )
    rmSync(join(
      f.home,
      'hydras/default/snapshot.json',
    ))
    f.run({
      args: [
        'column',
        'describe',
        'custom:triage',
        '--description',
        'Check new reports here',
      ],
    })
    const after = f.state()

    for (const key of [
      'old',
      'manual',
    ]) {
      const id = before.keys[key]!
      assert.equal(
        after.cards[id]!.column,
        before.cards[id]!.column,
      )
    }

    assert.ok(after.config!.columns.every(column => column.rule !== undefined))
    assert.ok(
      readFileSync(
        logPath,
        'utf8',
      ).startsWith(legacy),
      'migration only appends to the existing log',
    )
    f.run({
      args: [
        'task',
        'rename',
        'old',
        '--title',
        'Still in triage',
      ],
    })
    const migrations = readFileSync(
      logPath,
      'utf8',
    ).trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(event => event.type === 'board.columns' && event.actor === 'pnyx')
    assert.equal(
      migrations.length,
      1,
    )
    assert.equal(
      f.state().cards[before.keys.old!]!.column,
      'custom:triage',
    )
    f.run({
      args: [
        'task',
        'status',
        'old',
        'paused',
        '--hold',
      ],
    })
    assert.equal(
      f.state().cards[before.keys.old!]!.column,
      after.config!.columns.find(column => column.role === 'parked')!.id,
    )
  },
)

test(
  'push is an idempotent upsert by key',
  () => {
    const {
      run,
      card,
    } = hydraId()
    const file = card({
      json: {
        title: 'Ship login',
        workspace: 'work',
        tags: ['auth'],
      },
    })
    assert.match(
      run({
        args: [
          'push',
          '--key',
          'claude:s1',
          '--file',
          file,
        ],
      }),
      /^ {2}id: c1$/m,
    )
    assert.match(
      run({
        args: [
          'push',
          '--key',
          'claude:s1',
          '--file',
          file,
        ],
      }),
      /^event: "none: unchanged"$/m,
    )
    assert.match(
      run({
        args: [
          'push',
          '--key',
          'claude:s1',
          '--file',
          card({ json: { title: 'x' } }),
          '--event-id',
          'e1',
        ],
      }),
      /^ {2}seq: 2$/m,
    )
    const retry = run({
      args: [
        'push',
        '--key',
        'claude:s1',
        '--file',
        card({ json: { title: 'y' } }),
        '--event-id',
        'e1',
      ],
    })
    assert.match(
      retry,
      /^ {2}seq: 2$/m,
    )
    assert.match(
      retry,
      /^duplicate: /m,
    )
    const out = run({ args: [] })
    assert.match(
      out,
      /^ {2}in_progress: 1$/m,
    )
    assert.match(
      out,
      /^ {2}c1,x,in_progress,none$/m,
    )
  },
)

test(
  'history pages newest first and filters',
  () => {
    const {
      run,
      card,
    } = hydraId()

    for (let i = 0; i < 5; i++) {
      run({
        args: [
          'push',
          '--key',
          'k',
          '--file',
          card({ json: { title: `t${i}` } }),
        ],
      })
    }

    const first = run({
      args: [
        'history',
        '--limit',
        '2',
      ],
    })
    assert.match(
      first,
      /^events\[2\]/m,
    )
    assert.match(
      first,
      /^ {2}5,evt_5,/m,
    )
    assert.match(
      first,
      /history --limit 2 --before 4/,
    )
    const next = run({
      args: [
        'history',
        '--limit',
        '2',
        '--before',
        '4',
      ],
    })
    assert.match(
      next,
      /^ {2}3,evt_3,/m,
    )
    assert.match(
      run({
        args: [
          'history',
          '--kind',
          'moved',
        ],
      }),
      /^events: "none: no matching events"$/m,
    )
  },
)

test(
  'every write takes --event-id and --if-revision',
  () => {
    const {
      run,
      fails,
      card,
    } = hydraId()
    run({
      args: [
        'push',
        '--key',
        'k',
        '--file',
        card({ json: {} }),
        '--if-revision',
        '0',
      ],
    })
    fails({
      args: [
        'push',
        '--key',
        'k',
        '--file',
        card({ json: { title: 'x' } }),
        '--if-revision',
        '0',
      ],
      status: 1,
      code: 'REVISION_CONFLICT',
    })
    const url = 'https://github.com/o/r/pull/7'
    assert.match(
      run({
        args: [
          'link',
          'c1',
          '--url',
          url,
          '--state',
          'open',
          '--event-id',
          'l1',
          '--if-revision',
          '1',
        ],
      }),
      /^ {2}revision: 2$/m,
    )
    run({
      args: [
        'outcome',
        'c1',
        'done',
        '--event-id',
        'o1',
      ],
    })
    const retry = run({
      args: [
        'link',
        'c1',
        '--url',
        url,
        '--state',
        'open',
        '--event-id',
        'l1',
        '--if-revision',
        '1',
      ],
    })
    assert.match(
      retry,
      /^ {2}seq: 2$/m,
    )
    assert.match(
      retry,
      /^ {2}revision: 2$/m,
    )
    assert.match(
      retry,
      /^duplicate: /m,
    )
  },
)

test(
  'undo reverses a manual push edit and refuses a merge',
  () => {
    const {
      run,
      fails,
      card,
    } = hydraId()
    run({
      args: [
        'push',
        '--key',
        'k',
        '--file',
        card({ json: { title: 'Before' } }),
      ],
    })
    run({
      args: [
        'push',
        '--key',
        'k',
        '--file',
        card({ json: { title: 'After' } }),
      ],
    })
    run({
      args: [
        'undo',
        'evt_2',
      ],
    })
    assert.match(
      run({
        args: [
          'card',
          'c1',
        ],
      }),
      /^ {2}title: Before$/m,
    )
    fails({
      args: [
        'undo',
        'evt_1',
      ],
      status: 1,
      code: 'NOT_UNDOABLE',
    })
    run({
      args: [
        'link',
        'c1',
        '--url',
        'https://github.com/o/r/pull/7',
        '--state',
        'merged',
      ],
    })
    fails({
      args: [
        'undo',
        'evt_4',
      ],
      status: 1,
      code: 'NOT_UNDOABLE',
    })
    assert.match(
      run({
        args: [
          'card',
          'c1',
        ],
      }),
      /^ {2}column: in_progress$/m,
    )
  },
)

test(
  'errors are structured',
  () => {
    const { fails } = hydraId()
    fails({
      args: [
        'card',
        'c9',
      ],
      status: 1,
      code: 'NOT_FOUND',
    })
    fails({
      args: [
        'move',
        'c1',
      ],
      status: 2,
      code: 'VALIDATION_ERROR',
    })
  },
)

test(
  'a torn tail blocks writes until repair',
  () => {
    const {
      home,
      run,
      fails,
      card,
    } = hydraId()
    run({
      args: [
        'push',
        '--key',
        'k',
        '--file',
        card({ json: { title: 'a' } }),
      ],
    })
    appendFileSync(
      join(
        home,
        'hydras',
        'default',
        'events.jsonl',
      ),
      '{"v":1,"seq":2,"id":"ev',
    )
    assert.match(
      run({ args: [] }),
      /torn tail/,
    )
    fails({
      args: [
        'move',
        'c1',
        'done',
      ],
      status: 1,
      code: 'TORN_TAIL',
    })
    assert.match(
      run({ args: ['repair'] }),
      /set aside 23 torn bytes/,
    )
    assert.match(
      run({
        args: [
          'move',
          'c1',
          'done',
        ],
      }),
      /^ {2}seq: 2$/m,
    )
  },
)

test(
  'spooled hook events are ingested once, in order, by the next write',
  () => {
    const {
      env,
      run,
      card,
    } = hydraId()
    process.env.PNYX_HOME = env.PNYX_HOME
    spoolWrite({
      hydraId: 'default',
      entry: {
        id: 'hook-1',
        key: 'codex:t1',
        at: '2026-10-13T10:00:00Z',
        actor: 'hook',
        card: { title: 'From hook' },
      },
    })
    spoolWrite({
      hydraId: 'default',
      entry: {
        id: 'hook-1',
        key: 'codex:t1',
        at: '2026-10-13T10:00:01Z',
        card: { title: 'Respooled' },
      },
    })
    const spool = join(
      hydraDir({ hydraId: 'default' }),
      'spool',
    )
    writeFileSync(
      join(
        spool,
        '999-bad.json',
      ),
      '{nope',
    )
    const out = run({
      args: [
        'push',
        '--key',
        'other',
        '--file',
        card({ json: {} }),
      ],
    })
    assert.match(
      out,
      /^ {2}ingested: 2$/m,
    )
    assert.match(
      out,
      /^ {2}rejected: 1$/m,
    )
    assert.match(
      run({
        args: [
          'card',
          'codex:t1',
        ],
      }),
      /^ {2}title: From hook$/m,
    )
    assert.deepEqual(
      readdirSync(spool),
      ['999-bad.json.rejected'],
    )
    assert.match(
      run({ args: ['history'] }),
      /^events\[2\]/m,
    )
  },
)

test(
  'a spooled hook push is an observation, so undo refuses it',
  () => {
    const {
      env,
      run,
      fails,
      card,
    } = hydraId()
    process.env.PNYX_HOME = env.PNYX_HOME
    run({
      args: [
        'push',
        '--key',
        'codex:t1',
        '--file',
        card({ json: { title: 'Manual' } }),
      ],
    })
    spoolWrite({
      hydraId: 'default',
      entry: {
        id: 'hook-7',
        key: 'codex:t1',
        at: '2026-10-13T10:00:00Z',
        card: { activity: 'idle' },
      },
    })
    run({
      args: [
        'push',
        '--key',
        'other',
        '--file',
        card({ json: {} }),
      ],
    })
    assert.match(
      run({
        args: [
          'card',
          'codex:t1',
        ],
      }),
      /^ {2}activity: idle$/m,
    )
    fails({
      args: [
        'undo',
        'hook-7',
      ],
      status: 1,
      code: 'NOT_UNDOABLE',
    })
  },
)

test(
  'an event id reused for another card or type is an idempotency conflict',
  () => {
    const {
      run,
      fails,
      card,
    } = hydraId()
    run({
      args: [
        'push',
        '--key',
        'a',
        '--file',
        card({ json: {} }),
      ],
    })
    run({
      args: [
        'push',
        '--key',
        'b',
        '--file',
        card({ json: {} }),
        '--event-id',
        'x1',
      ],
    })
    fails({
      args: [
        'push',
        '--key',
        'a',
        '--file',
        card({ json: { title: 't' } }),
        '--event-id',
        'x1',
      ],
      status: 1,
      code: 'IDEMPOTENCY_CONFLICT',
    })
    fails({
      args: [
        'move',
        'b',
        'done',
        '--event-id',
        'x1',
      ],
      status: 1,
      code: 'IDEMPOTENCY_CONFLICT',
    })
    assert.match(
      run({
        args: [
          'push',
          '--key',
          'b',
          '--file',
          card({ json: { title: 't' } }),
          '--event-id',
          'x1',
        ],
      }),
      /^duplicate: /m,
    )
  },
)

test(
  'concurrent writers get one contiguous sequence',
  async () => {
    const {
      env,
      run,
      card,
    } = hydraId()
    const exec = promisify(execFile)
    const file = card({ json: {} })
    await Promise.all(
      Array.from(
        { length: 8 },
        (
          _,
          i,
        ) => exec(
          process.execPath,
          [
            BIN,
            'push',
            '--key',
            `k${i}`,
            '--file',
            file,
          ],
          { env },
        ),
      ),
    )
    const log = readFileSync(
      join(
        env.PNYX_HOME,
        'hydras',
        'default',
        'events.jsonl',
      ),
      'utf8',
    ).trimEnd()
      .split('\n')
    assert.deepEqual(
      log.map(l => JSON.parse(l).seq),
      [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
      ],
    )
    assert.match(
      run({ args: [] }),
      /^ {2}in_progress: 8$/m,
    )
    assert.equal(
      existsSync(join(
        env.PNYX_HOME,
        'hydras',
        'default',
        'writer.lock',
      )),
      false,
    )
  },
)

test(
  'only a Firstmate-linked Hydra keeps its default columns from deletion, and the move onto them cannot be undone',
  () => {
    const firstmate = {
      ...emptyHydra(),
      config: {
        id: 'default',
        name: 'default',
        hydra: {
          id: 'fm',
          kind: 'firstmate' as const,
          name: 'Hydra',
          home: '/home',
        },
        columns: [
          ...DEFAULT_COLUMNS,
          {
            id: 'custom:mine' as const,
            title: 'Mine',
          },
        ],
      },
    }
    assert.equal(
      lockedColumn({
        state: firstmate,
        id: 'needs_you',
      }),
      true,
    )
    assert.equal(
      lockedColumn({
        state: firstmate,
        id: 'custom:mine',
      }),
      false,
    )
    assert.equal(
      lockedColumn({
        state: {
          ...firstmate,
          config: {
            ...firstmate.config,
            hydra: {
              id: 'h',
              kind: 'agent',
              name: 'Hydra',
            },
          },
        },
        id: 'needs_you',
      }),
      false,
    )
    const legacy = {
      ...firstmate,
      config: {
        ...firstmate.config,
        columns: [
          {
            id: 'workers_on_it' as const,
            title: 'Workers on it',
            role: 'workers_on_it' as const,
          },
        ],
      },
    }
    const decision = migrateColumns({
      state: legacy,
      meta: {
        at: '2026-10-15T00:00:00.000Z',
        actor: 'pnyx',
      },
    })
    assert.ok('event' in decision)
    assert.throws(
      () => decideUndo({
        state: reduce({
          state: legacy,
          event: decision.event,
        }),
        target: decision.event,
        meta: {
          at: '2026-10-15T00:00:01.000Z',
          actor: 'cli',
        },
      }),
      (error: unknown) => error instanceof HydraError && error.code === 'NOT_UNDOABLE',
    )
  },
)

test(
  'legacy layout migration preserves cards in surviving custom columns through the writer',
  t => {
    const f = hydraId()
    t.after(() => rmSync(
      f.home,
      {
        recursive: true,
        force: true,
      },
    ))
    f.run({
      args: [
        'hydra',
        'create',
        'default',
      ],
    })
    const base = {
      v: 1,
      at: '2026-10-20T00:00:00Z',
      actor: 'cli',
    }
    const legacy = [
      {
        ...base,
        id: 'config',
        seq: 1,
        cardId: '$board',
        type: 'board.configured',
        data: {
          id: 'default',
          name: 'Old Hydra',
          hydra: {
            id: 'hydra',
            name: 'Hydra',
            kind: 'agent',
          },
          columns: [
            {
              id: 'workers_on_it',
              title: 'Workers on it',
              role: 'workers_on_it',
            },
            {
              id: 'custom:research',
              title: 'Research',
            },
          ],
        },
      },
      {
        ...base,
        id: 'custom',
        seq: 2,
        cardId: 'custom-card',
        type: 'task.created',
        data: {
          key: 'custom',
          title: 'Manually researching',
          column: 'custom:research',
        },
      },
      {
        ...base,
        id: 'working',
        seq: 3,
        cardId: 'custom-card',
        type: 'task.declared',
        data: {
          state: 'working',
          note: 'In flight',
        },
      },
      {
        ...base,
        id: 'legacy',
        seq: 4,
        cardId: 'legacy-card',
        type: 'task.created',
        data: {
          key: 'legacy',
          title: 'Old worker',
          column: 'workers_on_it',
        },
      },
    ].map(event => JSON.stringify(event)).join('\n') + '\n'
    const logPath = join(
      f.home,
      'hydras/default/events.jsonl',
    )
    writeFileSync(
      logPath,
      legacy,
    )
    rmSync(join(
      f.home,
      'hydras/default/snapshot.json',
    ))
    f.run({
      args: [
        'task',
        'rename',
        'custom',
        '--title',
        'Still researching',
      ],
    })
    assert.equal(
      f.state().cards['custom-card']!.column,
      'custom:research',
    )
    assert.equal(
      f.state().cards['legacy-card']!.column,
      'in_progress',
    )
    assert.ok(readFileSync(
      logPath,
      'utf8',
    ).startsWith(legacy))
    const moves = readFileSync(
      logPath,
      'utf8',
    ).trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(event => event.type === 'card.moved' && event.cardId === 'custom-card')
    assert.deepEqual(
      moves,
      [],
    )
  },
)

test(
  'reordering matching rules previews placement and undo restores the order and cards',
  t => {
    const f = hydraId()
    t.after(() => rmSync(
      f.home,
      {
        recursive: true,
        force: true,
      },
    ))
    f.run({
      args: [
        'hydra',
        'create',
        'default',
      ],
    })

    for (const id of [
      'custom:first',
      'custom:second',
    ]) {
      f.run({
        args: [
          'column',
          'create',
          '--id',
          id,
          '--title',
          id,
        ],
      })
      f.run({
        args: [
          'column',
          'reorder',
          id,
          '--before',
          'queued',
        ],
      })
      f.run({
        args: [
          'column',
          'rule',
          id,
          '--when',
          'kind:investigation,!owner-question,!held,!done',
          '--reason',
          'Group investigations',
        ],
      })
    }

    for (const key of [
      'research',
      'manual',
    ]) {
      f.run({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
          '--kind',
          'investigation',
        ],
      })
    }

    f.run({
      args: [
        'move',
        'manual',
        'parked',
      ],
    })
    const before = f.state()
    const research = before.keys.research!
    const manual = before.keys.manual!
    assert.equal(
      before.cards[research]!.column,
      'custom:first',
    )
    assert.equal(
      before.cards[manual]!.column,
      before.config!.columns.find(column => column.role === 'parked')!.id,
    )
    const command = [
      'column',
      'reorder',
      'custom:second',
      '--before',
      'custom:first',
    ]
    const preview = f.execute({ args: command })
    assert.match(
      preview,
      /^confirmation: needed$/m,
    )
    assert.match(
      preview,
      /affectedCards: 2/,
    )
    assert.deepEqual(
      f.state(),
      before,
    )
    const token = /^token: (\S+)$/m.exec(preview)![1]!
    const result = f.execute({
      args: [
        ...command,
        '--confirm',
        token,
      ],
    })
    assert.equal(
      f.state().config!.columns[0]!.id,
      'custom:second',
    )
    assert.equal(
      f.state().cards[research]!.column,
      'custom:second',
    )
    assert.equal(
      f.state().cards[manual]!.column,
      'custom:second',
    )
    const event = /^ {2}id: (\S+)$/m.exec(result)![1]!
    f.run({
      args: [
        'undo',
        event,
      ],
    })
    assert.deepEqual(
      f.state().config!.columns,
      before.config!.columns,
    )
    assert.equal(
      f.state().cards[research]!.column,
      'custom:first',
    )
    assert.equal(
      f.state().cards[manual]!.column,
      before.cards[manual]!.column,
    )
  },
)

test(
  'deleting a matching rule column previews and reverses every move while honoring its fallback',
  t => {
    const f = hydraId()
    t.after(() => rmSync(
      f.home,
      {
        recursive: true,
        force: true,
      },
    ))
    f.run({
      args: [
        'hydra',
        'create',
        'default',
      ],
    })
    f.run({
      args: [
        'column',
        'create',
        '--id',
        'custom:research',
        '--title',
        'Research',
      ],
    })
    f.run({
      args: [
        'column',
        'reorder',
        'custom:research',
        '--before',
        'queued',
      ],
    })
    f.run({
      args: [
        'column',
        'rule',
        'custom:research',
        '--when',
        'kind:investigation',
        '--reason',
        'Research gets a column',
      ],
    })

    for (const key of [
      'inside',
      'outside',
    ]) {
      f.run({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
          '--kind',
          'investigation',
        ],
      })
      f.run({
        args: [
          'task',
          'status',
          key,
          'working',
        ],
      })
    }

    f.run({
      args: [
        'move',
        'outside',
        'parked',
      ],
    })
    const before = f.state()
    const command = [
      'column',
      'delete',
      'custom:research',
      '--to',
      'queued',
    ]
    const preview = f.execute({ args: command })
    assert.match(
      preview,
      /affectedCards: 2/,
    )
    assert.equal(
      f.state().cards[before.keys.outside!]!.column,
      before.cards[before.keys.outside!]!.column,
    )
    const token = /^token: (\S+)$/m.exec(preview)![1]!
    const result = f.execute({
      args: [
        ...command,
        '--confirm',
        token,
      ],
    })
    const role = ({ name }: { name: string }) =>
      before.config!.columns.find(column => column.role === name)!.id
    assert.equal(
      f.state().cards[before.keys.inside!]!.column,
      role({ name: 'queued' }),
    )
    assert.equal(
      f.state().cards[before.keys.outside!]!.column,
      role({ name: 'in_progress' }),
    )
    const event = /^ {2}id: (\S+)$/m.exec(result)![1]!
    f.run({
      args: [
        'undo',
        event,
      ],
    })

    for (const key of [
      'inside',
      'outside',
    ]) {
      const id = before.keys[key]!
      assert.equal(
        f.state().cards[id]!.column,
        before.cards[id]!.column,
      )
    }
  },
)
