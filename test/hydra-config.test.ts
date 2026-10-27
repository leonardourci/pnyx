import { fixtureCli } from './cli-fixture.ts'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { migrateColumns } from '../src/core/hydra.ts'
import { type HydraState, type HydraColumn, type Card } from '../src/core/model.ts'
import { emptyHydra, reduce } from '../src/core/reducer.ts'

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
      /^ {2}c1,x,none,in_progress$/m,
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
