import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, appendFileSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import { repairHydra } from '#app/repair.ts'
import { ApplyError } from './schema.ts'

function fixture({ t }: { t: TestContext }) {
  const previous = { ...process.env }
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-apply-',
  ))
  process.env.PNYX_HOME = join(
    root,
    'home',
  )
  process.env.PNYX_ACTOR = 'cli'
  delete process.env.PNYX_TASK
  delete process.env.PNYX_HYDRA
  t.after(() => {
    process.env = previous
    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  })
  const path = join(
    root,
    'changes.json',
  )
  const dir = join(
    root,
    'home',
    'hydras',
    'default',
  )

  const apply = ({
    document,
    flags = [],
  }: {
    document: unknown
    flags?: string[]
  }) => {
    writeFileSync(
      path,
      JSON.stringify(document),
    )

    return commands.apply([
      '--file',
      path,
      ...flags,
    ])
  }

  return {
    root,
    dir,
    path,
    apply,
  }
}

test(
  'check previews without writes; one durable record replays all tasks, dependencies and lifecycle effects',
  t => {
    const f = fixture({ t })
    const document: unknown = JSON.parse(readFileSync(
      new URL(
        './fixtures/related-tasks.json',
        import.meta.url,
      ),
      'utf8',
    ))
    const check = f.apply({
      document,
      flags: [
        '--check',
        '--event-id',
        'export-plan',
      ],
    })
    assert.equal(
      check.applied,
      false,
    )
    assert.equal(
      check.check,
      true,
    )
    assert.equal(
      (check.diff as unknown[]).length,
      2,
    )
    assert.deepEqual(
      readdirSync(f.root),
      ['changes.json'],
    )
    const result = f.apply({
      document,
      flags: [
        '--event-id',
        'export-plan',
      ],
    })
    const aliases = result.aliases as {
      research: string
      build: string
    }
    assert.deepEqual(
      result.aliases,
      check.aliases,
    )
    assert.equal(
      result.applied,
      true,
    )
    const log = join(
      f.dir,
      'events.jsonl',
    )
    const lines = readFileSync(
      log,
      'utf8',
    ).trim()
      .split('\n')
    assert.equal(
      lines.length,
      1,
    )
    assert.equal(
      JSON.parse(lines[0]!).type,
      'log.transaction',
    )
    const before = loadHydra({ hydraId: 'default' }).state
    assert.deepEqual(
      before.cards[aliases.build]?.prerequisites,
      [aliases.research],
    )
    assert.equal(
      before.cards[aliases.build]?.brief,
      'Use the research findings',
    )
    assert.equal(
      before.cards[aliases.research]?.status?.state,
      'working',
    )
    assert.equal(
      before.cards[aliases.research]?.column,
      'in_progress',
    )
    assert.equal(
      before.cards[aliases.research]?.links[0]?.url,
      'https://example.com/formats',
    )
    rmSync(join(
      f.dir,
      'snapshot.json',
    ))
    assert.deepEqual(
      loadHydra({ hydraId: 'default' }).state,
      before,
    )
    const events = readEvents({ hydraId: 'default' })
    assert.ok(events.some(event => event.type === 'card.moved' && event.transaction === 'export-plan'))
    const last = events.at(-1)!
    assert.throws(
      () => commands.undo([last.id]),
      /append a correction with apply/,
    )
    commands.task([
      'brief',
      aliases.build,
      '--brief',
      'Later instructions',
    ])
    const afterEdit = readFileSync(
      log,
      'utf8',
    )
    const retry = f.apply({
      document,
      flags: [
        '--event-id',
        'export-plan',
      ],
    })
    assert.equal(
      retry.duplicate,
      true,
    )
    assert.deepEqual(
      retry.revisions,
      result.revisions,
    )
    assert.equal(
      readFileSync(
        log,
        'utf8',
      ),
      afterEdit,
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.create',
              title: 'Different',
            },
          ],
        },
        flags: [
          '--event-id',
          'export-plan',
        ],
      }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    )
  },
)

test(
  'independent invalid operations return indexed fields and leave both log and snapshot unchanged',
  t => {
    const f = fixture({ t })
    commands.task([
      'create',
      '--key',
      'existing',
      '--title',
      'Existing',
    ])
    const log = readFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      'utf8',
    )
    const snapshot = readFileSync(
      join(
        f.dir,
        'snapshot.json',
      ),
      'utf8',
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.brief',
              task: 'existing',
              brief: 'Must not persist',
            },
            {
              op: 'task.create',
              as: 'new',
              title: 'Must not exist',
            },
            {
              op: 'task.depend',
              task: '$new',
              on: ['missing'],
            },
            {
              op: 'outcome',
              task: 'existing',
              state: 'wrong',
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.deepEqual(
          error.errors.map(issue => issue.path),
          [
            '/changes/2/on/0',
            '/changes/3/state',
          ],
        )

        return true
      },
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'snapshot.json',
        ),
        'utf8',
      ),
      snapshot,
    )
    assert.equal(
      Object.keys(loadHydra({ hydraId: 'default' }).state.cards).length,
      1,
    )
  },
)

test(
  'expected revisions watch tasks rather than the global sequence; stale input and dependency cycles write nothing',
  t => {
    const f = fixture({ t })
    commands.task([
      'create',
      '--key',
      'a',
      '--title',
      'A',
    ])
    const initial = loadHydra({ hydraId: 'default' }).state
    const a = initial.keys.a!
    const revision = initial.cards[a]!.revision
    commands.task([
      'create',
      '--key',
      'b',
      '--title',
      'B',
    ])
    const document = {
      version: 1,
      expected: { tasks: { a: revision } },
      changes: [
        {
          op: 'task.brief',
          task: 'a',
          brief: 'Updated A',
        },
      ],
    }
    assert.equal(
      f.apply({ document }).applied,
      true,
    )
    const log = readFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      'utf8',
    )
    assert.throws(
      () => f.apply({ document }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.equal(
          error.errors[0]?.code,
          'REVISION_CONFLICT',
        )
        assert.equal(
          error.errors[0]?.path,
          '/expected/tasks/a',
        )

        return true
      },
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.depend',
              task: 'a',
              on: ['b'],
            },
            {
              op: 'task.depend',
              task: 'b',
              on: ['a'],
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.equal(
          error.errors[0]?.code,
          'DEPENDENCY_CYCLE',
        )

        return true
      },
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
  },
)

test(
  'a torn compound record exposes none of its children and repair preserves the original log',
  t => {
    const f = fixture({ t })
    commands.task([
      'create',
      '--key',
      'base',
      '--title',
      'Base',
    ])
    const original = readFileSync(join(
      f.dir,
      'events.jsonl',
    ))
    f.apply({
      document: {
        version: 1,
        changes: [
          {
            op: 'task.brief',
            task: 'base',
            brief: 'Atomic instructions',
          },
          {
            op: 'task.create',
            title: 'Atomic new task',
          },
        ],
      },
    })
    const full = readFileSync(join(
      f.dir,
      'events.jsonl',
    ))
    const transaction = full.subarray(original.length)
    rmSync(join(
      f.dir,
      'snapshot.json',
    ))
    const torn = Buffer.concat([
      original,
      transaction.subarray(
        0,
        transaction.length - 2,
      ),
    ])
    writeFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      torn,
    )
    const state = loadHydra({ hydraId: 'default' }).state
    assert.equal(
      Object.keys(state.cards).length,
      1,
    )
    assert.equal(
      state.cards[state.keys.base!]?.brief,
      undefined,
    )
    assert.throws(
      () => commands.task([
        'brief',
        'base',
        '--brief',
        'Blocked',
      ]),
      { code: 'TORN_TAIL' },
    )
    repairHydra({ hydraId: 'default' })
    assert.ok(readFileSync(join(
      f.dir,
      'events.jsonl',
    )).subarray(
      0,
      torn.length,
    )
      .equals(torn))
    appendFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      transaction,
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[state.keys.base!]?.brief,
      'Atomic instructions',
    )
    assert.equal(
      Object.keys(loadHydra({ hydraId: 'default' }).state.cards).length,
      2,
    )
  },
)

test(
  'stdin input uses the real CLI and reports closed-schema errors with a failing exit status',
  t => {
    const f = fixture({ t })
    const input = JSON.stringify({
      version: 1,
      changes: [
        {
          op: 'task.create',
          title: 'Synthetic',
          argv: [
            'echo',
            'ignored',
          ],
        },
        {
          op: 'task.start',
          task: 'outside-scope',
        },
      ],
    })
    const result = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        'src/cli/pnyx-axi.ts',
        'apply',
        '--file',
        '-',
        '--check',
      ],
      {
        env: process.env,
        input,
        encoding: 'utf8',
      },
    )
    assert.equal(
      result.status,
      2,
    )
    assert.match(
      result.stdout,
      /applied: false/,
    )
    assert.match(
      result.stdout,
      /errors\[2\]/,
    )
    assert.match(
      result.stdout,
      /\/changes\/0\/argv/,
    )
    assert.match(
      result.stdout,
      /\/changes\/1\/op/,
    )
    assert.deepEqual(
      readdirSync(f.root),
      [],
    )
  },
)

test(
  'owner asks and release retain owner-message provenance, and worker authority cannot bypass holds or prerequisites',
  async t => {
    const f = fixture({ t })
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.parse('2026-10-29T10:00:00Z'),
    })
    f.apply({
      document: {
        version: 1,
        changes: [
          {
            op: 'task.create',
            key: 'held',
            title: 'Held task',
            hold: true,
            reason: 'Discuss export',
          },
          {
            op: 'task.create',
            key: 'prerequisite',
            title: 'Prerequisite',
          },
        ],
      },
    })
    t.mock.timers.tick(100)
    const message = await commands.hydra([
      'send',
      '--text',
      'Go build the export',
    ])
    const messageId = message.message as string
    process.env.PNYX_ACTOR = 'hydra'
    const result = f.apply({
      document: {
        version: 1,
        changes: [
          {
            op: 'task.release',
            task: 'held',
            message: messageId,
            reason: 'Owner gave go',
          },
          {
            op: 'task.owner-ask',
            task: 'held',
            text: 'Go build the export',
            message: messageId,
            reason: 'Save owner ask',
          },
          {
            op: 'task.depend',
            task: 'held',
            on: ['prerequisite'],
          },
          {
            op: 'task.undepend',
            task: 'held',
            on: ['prerequisite'],
          },
          {
            op: 'task.status',
            task: 'held',
            status: 'paused',
            hold: true,
            note: 'Wait for files',
          },
        ],
      },
    })
    assert.equal(
      result.applied,
      true,
    )
    const state = loadHydra({ hydraId: 'default' }).state
    const held = state.cards[state.keys.held!]!
    assert.equal(
      held.hold,
      undefined,
    )
    assert.equal(
      held.ask?.[0]?.message,
      messageId,
    )
    assert.equal(
      held.ask?.[0]?.actor,
      'cli',
    )
    assert.equal(
      held.status?.hold,
      true,
    )
    assert.deepEqual(
      held.prerequisites,
      [],
    )
    const log = readFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      'utf8',
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.owner-ask',
              task: 'held',
              text: 'Invented permission',
              message: messageId,
              reason: 'Bad quote',
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.equal(
          error.errors[0]?.code,
          'ASK_SOURCE_MISMATCH',
        )
        assert.equal(
          error.errors[0]?.path,
          '/changes/0/message',
        )

        return true
      },
    )
    process.env.PNYX_ACTOR = 'worker:synthetic'
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.hold',
              task: 'held',
              reason: 'Worker hold',
            },
            {
              op: 'task.depend',
              task: 'held',
              on: ['prerequisite'],
            },
            {
              op: 'task.owner-ask',
              task: 'held',
              text: 'Unsigned ask',
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.deepEqual(
          error.errors.map(issue => issue.code),
          [
            'OWNER_ONLY',
            'OWNER_ONLY',
            'OWNER_ONLY',
          ],
        )

        return true
      },
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
  },
)

test(
  'status done cannot bypass report or landing gates, including a later operation in the same document',
  t => {
    const f = fixture({ t })
    commands.task([
      'create',
      '--key',
      'research',
      '--title',
      'Research',
      '--kind',
      'investigation',
    ])
    commands.task([
      'create',
      '--key',
      'build',
      '--title',
      'Build',
    ])
    const log = readFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      'utf8',
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.brief',
              task: 'build',
              brief: 'Do not persist',
            },
            {
              op: 'task.status',
              task: 'research',
              status: 'done',
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.equal(
          error.errors[0]?.code,
          'NOT_LANDED',
        )

        return true
      },
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.status',
              task: 'build',
              status: 'done',
            },
            {
              op: 'link',
              task: 'build',
              url: 'https://github.com/example/synthetic/pull/1',
              state: 'open',
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.equal(
          error.errors[0]?.code,
          'NOT_LANDED',
        )

        return true
      },
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
  },
)

test(
  'local links and outcomes share short-command validation; an unchanged apply still owns its retry identity',
  t => {
    const f = fixture({ t })
    commands.task([
      'create',
      '--key',
      'a',
      '--title',
      'A',
    ])
    f.apply({
      document: {
        version: 1,
        changes: [
          {
            op: 'link',
            task: 'a',
            url: 'https://example.com/proof',
            title: 'Proof',
          },
          {
            op: 'outcome',
            task: 'a',
            state: 'failed',
            note: 'Synthetic failure',
          },
        ],
      },
    })
    let state = loadHydra({ hydraId: 'default' }).state
    assert.equal(
      state.cards[state.keys.a!]?.outcome?.state,
      'failed',
    )
    f.apply({
      document: {
        version: 1,
        changes: [
          {
            op: 'link',
            task: 'a',
            url: 'https://example.com/proof',
            remove: true,
          },
          {
            op: 'outcome',
            task: 'a',
            clear: true,
          },
        ],
      },
    })
    state = loadHydra({ hydraId: 'default' }).state
    assert.deepEqual(
      state.cards[state.keys.a!]?.links,
      [],
    )
    assert.equal(
      state.cards[state.keys.a!]?.outcome,
      undefined,
    )
    const noop = {
      version: 1,
      changes: [
        {
          op: 'task.brief',
          task: 'a',
          brief: '',
        },
      ],
    }
    f.apply({
      document: noop,
      flags: [
        '--event-id',
        'noop-id',
      ],
    })
    const log = readFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      'utf8',
    )
    assert.equal(
      f.apply({
        document: noop,
        flags: [
          '--event-id',
          'noop-id',
        ],
      }).duplicate,
      true,
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.brief',
              task: 'a',
              brief: 'Changed',
            },
          ],
        },
        flags: [
          '--event-id',
          'noop-id',
        ],
      }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    )
    assert.throws(
      () => commands.link([
        'a',
        '--url',
        'https://example.com',
        '--remove',
        '--title',
        'Ignored',
      ]),
      /remove/,
    )
    assert.throws(
      () => commands.outcome([
        'a',
        '--clear',
        '--note',
        'Ignored',
      ]),
      /clear/,
    )
    assert.throws(
      () => commands.task([
        'create',
        '--title',
        'Ignored dependency',
        '--on',
        'a',
      ]),
      /on/,
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
  },
)

test(
  'check and rejected documents preserve stale leases, and apply IDs are reserved against short commands',
  t => {
    const f = fixture({ t })
    const created = commands.task([
      'create',
      '--key',
      'a',
      '--title',
      'A',
      '--event-id',
      'ordinary-id',
    ])
    assert.ok(!(created instanceof Promise))
    const task = (created.card as { id: string }).id
    const leasePath = join(
      f.dir,
      `helper-lease-${task}.json`,
    )
    const lease = JSON.stringify({
      actor: 'helper:stale',
      holders: [
        {
          id: 'gone',
          pid: 2147483647,
        },
      ],
    })
    writeFileSync(
      leasePath,
      lease,
    )
    const document = {
      version: 1,
      changes: [
        {
          op: 'task.brief',
          task: 'a',
          brief: 'Preview',
        },
      ],
    }
    f.apply({
      document,
      flags: ['--check'],
    })
    assert.equal(
      readFileSync(
        leasePath,
        'utf8',
      ),
      lease,
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.brief',
              task: 'a',
              brief: 'Rejected',
            },
            {
              op: 'task.depend',
              task: 'a',
              on: ['missing'],
            },
          ],
        },
      }),
      ApplyError,
    )
    assert.equal(
      readFileSync(
        leasePath,
        'utf8',
      ),
      lease,
    )
    f.apply({
      document,
      flags: [
        '--event-id',
        'batch-id',
      ],
    })
    assert.throws(
      () => commands.task([
        'brief',
        'a',
        '--brief',
        'Wrong ID',
        '--event-id',
        'batch-id',
      ]),
      { code: 'IDEMPOTENCY_CONFLICT' },
    )
    assert.equal(
      f.apply({
        document,
        flags: [
          '--event-id',
          'batch-id',
        ],
      }).duplicate,
      true,
    )
    assert.throws(
      () => f.apply({
        document,
        flags: [
          '--event-id',
          'ordinary-id',
        ],
      }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    )
    const noop = {
      version: 1,
      changes: [
        {
          op: 'task.brief',
          task: 'a',
          brief: 'Preview',
        },
      ],
    }
    f.apply({
      document: noop,
      flags: [
        '--event-id',
        'noop-reserved',
      ],
    })
    rmSync(join(
      f.dir,
      'snapshot.json',
    ))
    assert.throws(
      () => commands.task([
        'brief',
        'a',
        '--brief',
        'Wrong no-op ID',
        '--event-id',
        'noop-reserved',
      ]),
      { code: 'IDEMPOTENCY_CONFLICT' },
    )
    assert.equal(
      f.apply({
        document: noop,
        flags: [
          '--event-id',
          'noop-reserved',
        ],
      }).duplicate,
      true,
    )
  },
)

test(
  'apply waits on the active writer before diagnosing an incomplete append',
  t => {
    const f = fixture({ t })
    commands.task([
      'create',
      '--key',
      'a',
      '--title',
      'A',
    ])
    const lock = join(
      f.dir,
      'writer.lock',
    )
    writeFileSync(
      lock,
      String(process.pid),
    )
    appendFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      '{"unfinished":',
    )
    const document = {
      version: 1,
      changes: [
        {
          op: 'task.brief',
          task: 'a',
          brief: 'Wait for writer',
        },
      ],
    }
    writeFileSync(
      f.path,
      JSON.stringify(document),
    )
    const result = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        'src/cli/pnyx-axi.ts',
        'apply',
        '--file',
        f.path,
      ],
      {
        env: process.env,
        encoding: 'utf8',
        timeout: 10000,
      },
    )
    assert.equal(
      result.status,
      1,
    )
    assert.match(
      result.stdout,
      /code: LOCKED/,
    )
    assert.doesNotMatch(
      result.stdout,
      /TORN_TAIL/,
    )
  },
)

test(
  'preview and invalid plans leave a legacy Hydra folder in place',
  t => {
    const f = fixture({ t })
    commands.task([
      'create',
      '--key',
      'a',
      '--title',
      'A',
    ])
    const boards = join(
      f.root,
      'home',
      'boards',
    )
    mkdirSync(boards)
    const legacy = join(
      boards,
      'default',
    )
    renameSync(
      f.dir,
      legacy,
    )
    const before = readFileSync(
      join(
        legacy,
        'events.jsonl',
      ),
      'utf8',
    )
    f.apply({
      document: {
        version: 1,
        changes: [
          {
            op: 'task.brief',
            task: 'a',
            brief: 'Preview',
          },
        ],
      },
      flags: ['--check'],
    })
    assert.equal(
      readFileSync(
        join(
          legacy,
          'events.jsonl',
        ),
        'utf8',
      ),
      before,
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.brief',
              task: 'a',
              brief: 'Do not persist',
            },
            {
              op: 'task.depend',
              task: 'a',
              on: ['missing'],
            },
          ],
        },
      }),
      ApplyError,
    )
    assert.equal(
      readFileSync(
        join(
          legacy,
          'events.jsonl',
        ),
        'utf8',
      ),
      before,
    )
    assert.deepEqual(
      readdirSync(join(
        f.root,
        'home',
        'hydras',
      )),
      [],
    )
  },
)

test(
  'invalid aliases, versions and operation fields report exact paths before committing',
  t => {
    const f = fixture({ t })
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.create',
              as: 'first',
              title: 'First',
            },
            {
              op: 'task.create',
              as: 'first',
              title: 'Duplicate alias',
            },
            {
              op: 'task.create',
              as: '1bad',
              title: 'Malformed alias',
            },
            {
              op: 'task.brief',
              task: '$later',
              brief: 'Forward reference',
            },
            {
              op: 'task.create',
              as: 'later',
              title: 'Later',
            },
            {
              op: 'task.create',
              title: 'Long ask',
              ask: 'x'.repeat(24001),
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.deepEqual(
          error.errors.map(issue => issue.path),
          [
            '/changes/1/as',
            '/changes/2/as',
            '/changes/3/task',
            '/changes/5/ask',
          ],
        )

        return true
      },
    )
    assert.deepEqual(
      readEvents({ hydraId: 'default' }),
      [],
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 2,
          changes: [
            {
              op: 'task.create',
              title: 'Bad hold type',
              hold: 'true',
            },
            {
              op: 'task.brief',
              task: 'a',
              brief: 1,
            },
            {
              op: 'task.start',
              task: 'a',
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.deepEqual(
          error.errors.map(issue => issue.path),
          [
            '/version',
            '/changes/0/hold',
            '/changes/1/brief',
            '/changes/2/op',
          ],
        )

        return true
      },
    )
    assert.deepEqual(
      readEvents({ hydraId: 'default' }),
      [],
    )
  },
)

test(
  'a child operation ID collision refuses the whole real CLI document, including valid siblings',
  t => {
    const f = fixture({ t })
    commands.task([
      'create',
      '--key',
      'a',
      '--title',
      'A',
    ])
    commands.task([
      'create',
      '--key',
      'b',
      '--title',
      'B',
    ])
    commands.task([
      'brief',
      'a',
      '--brief',
      'Original',
      '--event-id',
      'same-kind:op:0',
    ])
    commands.link([
      'b',
      '--url',
      'https://example.com/proof',
      '--event-id',
      'other-kind:op:0',
    ])
    const log = readFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      'utf8',
    )
    const snapshot = readFileSync(
      join(
        f.dir,
        'snapshot.json',
      ),
      'utf8',
    )
    const document = JSON.stringify({
      version: 1,
      changes: [
        {
          op: 'task.brief',
          task: 'a',
          brief: 'Requested new content',
        },
        {
          op: 'task.create',
          key: 'sibling',
          title: 'Must not exist',
        },
      ],
    })
    const same = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        'src/cli/pnyx-axi.ts',
        'apply',
        '--file',
        '-',
        '--event-id',
        'same-kind',
      ],
      {
        env: process.env,
        input: document,
        encoding: 'utf8',
      },
    )
    assert.equal(
      same.status,
      2,
    )
    assert.match(
      same.stdout,
      /0,"\/changes\/0\/op","IDEMPOTENCY_CONFLICT"/,
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'snapshot.json',
        ),
        'utf8',
      ),
      snapshot,
    )
    const other = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        'src/cli/pnyx-axi.ts',
        'apply',
        '--file',
        '-',
        '--event-id',
        'other-kind',
      ],
      {
        env: process.env,
        input: document,
        encoding: 'utf8',
      },
    )
    assert.equal(
      other.status,
      2,
    )
    assert.match(
      other.stdout,
      /0,"\/changes\/0\/op","IDEMPOTENCY_CONFLICT"/,
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'snapshot.json',
        ),
        'utf8',
      ),
      snapshot,
    )
  },
)

test(
  'hold and release attribute missing reasons to reason and invalid evidence to message',
  t => {
    const f = fixture({ t })
    commands.task([
      'create',
      '--key',
      'a',
      '--title',
      'A',
    ])
    const log = readFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      'utf8',
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.hold',
              task: 'a',
            },
            {
              op: 'task.release',
              task: 'a',
              message: 'missing-owner-message',
            },
            {
              op: 'task.release',
              task: 'a',
              message: 'missing-owner-message',
              reason: 'Release with evidence',
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.deepEqual(
          error.errors.map(issue => issue.path),
          [
            '/changes/0/reason',
            '/changes/1/reason',
            '/changes/2/message',
          ],
        )

        return true
      },
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
  },
)

test(
  'duplicate JSON members including escaped names are refused before any write',
  t => {
    const f = fixture({ t })
    const input = '{"version":999,"version":1,"changes":[{"op":"task.brief","op":"task.create","title":"First","ti\\u0074le":"Second","key":"json-dupe"}],"changes":[{"op":"task.create","title":"Other","key":"other"}]}'
    const result = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        'src/cli/pnyx-axi.ts',
        'apply',
        '--file',
        '-',
      ],
      {
        env: process.env,
        input,
        encoding: 'utf8',
      },
    )
    assert.equal(
      result.status,
      2,
    )
    assert.match(
      result.stdout,
      /errors\[4\]/,
    )
    assert.match(
      result.stdout,
      /"\/version"/,
    )
    assert.match(
      result.stdout,
      /"\/changes\/0\/op"/,
    )
    assert.match(
      result.stdout,
      /"\/changes\/0\/title"/,
    )
    assert.match(
      result.stdout,
      /"\/changes"/,
    )
    assert.deepEqual(
      readdirSync(f.root),
      [],
    )
  },
)

test(
  'apply and short commands keep Intent, brief and owner words separate',
  async t => {
    const f = fixture({ t })
    await commands.task([
      'create',
      '--key',
      'short',
      '--title',
      'Short task',
      '--intent',
      'Initial goal',
      '--brief',
      'Initial instructions',
      '--ask',
      'Exact owner words',
    ])
    f.apply({
      document: {
        version: 1,
        changes: [
          {
            op: 'task.create',
            key: 'bulk',
            title: 'Bulk task',
            intent: 'Bulk goal',
            brief: 'Bulk instructions',
            ask: 'Bulk owner words',
          },
          {
            op: 'task.brief',
            task: 'short',
            intent: 'Expanded goal',
          },
          {
            op: 'task.brief',
            task: 'bulk',
            intent: 'Expanded bulk goal',
            brief: 'Updated bulk instructions',
          },
        ],
      },
    })
    await commands.task([
      'brief',
      'short',
      '--intent',
      'Final goal',
      '--brief',
      'Final instructions',
    ])
    await commands.task([
      'owner-ask',
      'short',
      '--text',
      'Later owner words',
    ])
    const state = loadHydra({ hydraId: 'default' }).state
    const short = state.cards[state.keys.short!]!
    const bulk = state.cards[state.keys.bulk!]!
    assert.equal(
      short.intent,
      'Final goal',
    )
    assert.equal(
      short.brief,
      'Final instructions',
    )
    assert.deepEqual(
      short.ask?.map(ask => ask.text),
      [
        'Exact owner words',
        'Later owner words',
      ],
    )
    assert.equal(
      bulk.intent,
      'Expanded bulk goal',
    )
    assert.equal(
      bulk.brief,
      'Updated bulk instructions',
    )
    assert.equal(
      bulk.ask?.[0]?.text,
      'Bulk owner words',
    )
    const log = readFileSync(
      join(
        f.dir,
        'events.jsonl',
      ),
      'utf8',
    )
    assert.match(
      log,
      /"intent":"Expanded goal"/,
    )
    assert.throws(
      () => commands.task([
        'intent',
        'short',
        '--text',
        'Rejected legacy command',
      ]),
      /task owner-ask/,
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.brief',
              task: 'short',
              brief: 'Must not persist',
            },
            {
              op: 'task.intent',
              task: 'short',
              text: 'Rejected legacy operation',
            },
          ],
        },
      }),
      ApplyError,
    )
    assert.throws(
      () => f.apply({
        document: {
          version: 1,
          changes: [
            {
              op: 'task.brief',
              task: 'short',
              intent: 'x'.repeat(4001),
            },
          ],
        },
      }),
      error => {
        assert.ok(error instanceof ApplyError)
        assert.equal(
          error.errors[0]?.path,
          '/changes/0/intent',
        )

        return true
      },
    )
    assert.equal(
      readFileSync(
        join(
          f.dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
  },
)
