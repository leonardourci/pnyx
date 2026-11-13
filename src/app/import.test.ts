import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { HydraError } from '#store/errors.ts'
import { query } from '#store/postgres.ts'
import { logPath } from '#store/storage.ts'
import { storedHydra } from '#test-harness/database.ts'
import { hydraDir } from './home-migration.ts'
import { holdHydra, importLegacy, loadHydra, reloadHydra } from './store.ts'

// The plan an older Pnyx applied as `legacy-plan`, and the digest it recorded for it with actor cli.
const PLAN = {
  version: 1,
  changes: [
    {
      op: 'task.create',
      as: 'export',
      key: 'export',
      title: 'Build export',
    },
  ],
}
const PLAN_DIGEST = '7a52d3a5fd925c6ce1a439da61966d1038956d168866f3da68bb12d24dc1a9fb'
const PLAN_RECEIPT = {
  applied: true,
  id: 'legacy-plan',
  aliases: { export: 'task-export' },
  base: {},
  revisions: { 'task-export': 1 },
  operations: [
    {
      operation: 0,
      op: 'task.create',
      state: 'applied',
      task: 'task-export',
      event: 'legacy-plan:op:0',
    },
  ],
}

const transcriptCopy = ({
  seq,
  text,
}: {
  seq: number
  text: string
}) => ({
  v: 1,
  seq,
  id: `chat_${seq}`,
  at: '2026-10-21T10:02:00Z',
  actor: 'harvest',
  cardId: 'task-before',
  type: 'chat.message',
  data: {
    session: 'claude:sess-1',
    nativeId: `native-${seq}`,
    role: 'assistant',
    text,
  },
})

const LEGACY_LOG = [
  {
    v: 1,
    seq: 1,
    id: 'evt_1',
    at: '2026-10-21T10:01:00Z',
    actor: 'cli',
    cardId: 'task-before',
    type: 'task.created',
    data: {
      key: 'before',
      title: 'Before the plan',
    },
  },
  transcriptCopy({
    seq: 2,
    text: 'Looking at the export formats',
  }),
  {
    v: 1,
    type: 'log.transaction',
    id: 'legacy-plan',
    digest: PLAN_DIGEST,
    receipt: PLAN_RECEIPT,
    events: [
      {
        v: 1,
        seq: 3,
        id: 'legacy-plan:op:0',
        at: '2026-10-21T10:03:00Z',
        actor: 'cli',
        cardId: 'task-export',
        type: 'task.created',
        data: {
          key: 'export',
          title: 'Build export',
        },
        transaction: 'legacy-plan',
      },
      {
        v: 1,
        seq: 4,
        id: 'legacy-plan',
        at: '2026-10-21T10:03:00Z',
        actor: 'cli',
        cardId: '$board',
        type: 'apply.recorded',
        data: { digest: PLAN_DIGEST },
        transaction: 'legacy-plan',
      },
    ],
  },
  transcriptCopy({
    seq: 5,
    text: 'The export task is queued',
  }),
]

beforeEach(() => {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-import-',
  ))
  process.env.PNYX_HOME = join(
    root,
    'home',
  )
  process.env.PNYX_ACTOR = 'cli'
})

function seedLog({
  hydraId,
  lines,
}: {
  hydraId: string
  lines: unknown[]
}): void {
  const dir = hydraDir({ hydraId })
  mkdirSync(
    dir,
    { recursive: true },
  )
  writeFileSync(
    logPath({ dir }),
    lines.map(line => `${JSON.stringify(line)}\n`).join(''),
  )
}

// What the state holds once saved as JSON: fields set to undefined are gone.
const saved = ({ value }: { value: unknown }) => JSON.parse(JSON.stringify(value))

test(
  'an imported log leaves its transcript copies out, keeps its plan receipt for a re-sent plan, and records its size',
  async () => {
    seedLog({
      hydraId: 'legacy',
      lines: LEGACY_LOG,
    })
    const release = holdHydra({
      hydraId: 'legacy',
      changed: () => undefined,
    })

    try {
      const [
        events,
        transactions,
        hydras,
      ] = query({
        statements: [
          { text: 'select id, type from events where hydra_id = \'legacy\' order by seq' },
          { text: 'select id, digest, receipt from transactions where hydra_id = \'legacy\'' },
          { text: 'select imported_bytes from hydras where id = \'legacy\'' },
        ],
      })
      assert.deepEqual(
        events,
        [
          {
            id: 'evt_1',
            type: 'task.created',
          },
          {
            id: 'legacy-plan:op:0',
            type: 'task.created',
          },
          {
            id: 'legacy-plan',
            type: 'apply.recorded',
          },
        ],
      )
      assert.deepEqual(
        transactions,
        [
          {
            id: 'legacy-plan',
            digest: PLAN_DIGEST,
            receipt: PLAN_RECEIPT,
          },
        ],
      )
      assert.deepEqual(
        hydras,
        // Postgres returns the bigint as text.
        [{ imported_bytes: '1444' }],
      )
      assert.equal(
        statSync(logPath({ dir: hydraDir({ hydraId: 'legacy' }) })).size,
        1444,
      )

      const planPath = join(
        hydraDir({ hydraId: 'legacy' }),
        'plan.json',
      )
      writeFileSync(
        planPath,
        JSON.stringify(PLAN),
      )
      const before = storedHydra({ hydraId: 'legacy' })
      assert.deepEqual(
        await commands.apply([
          '--file',
          planPath,
          '--event-id',
          'legacy-plan',
          '--hydra',
          'legacy',
        ]),
        {
          ...PLAN_RECEIPT,
          duplicate: true,
        },
      )
      assert.equal(
        storedHydra({ hydraId: 'legacy' }),
        before,
        'the re-sent plan wrote nothing',
      )

      await commands.task([
        'create',
        '--title',
        'After the import',
        '--key',
        'after',
        '--hydra',
        'legacy',
      ])
      const inMemory = saved({ value: loadHydra({ hydraId: 'legacy' }).state })
      release()
      reloadHydra({ hydraId: 'legacy' })
      assert.deepEqual(
        saved({ value: loadHydra({ hydraId: 'legacy' }).state }),
        inMemory,
        'the Hydra read back from its rows equals the one in memory',
      )
    } finally {
      release()
    }
  },
)

test(
  'a log holding a NUL and a lone surrogate imports, with U+FFFD in their place',
  () => {
    seedLog({
      hydraId: 'odd',
      lines: [
        {
          v: 1,
          seq: 1,
          id: 'evt_1',
          at: '2026-10-21T10:01:00Z',
          actor: 'cli',
          cardId: 'task-odd',
          type: 'task.created',
          data: {
            key: 'odd',
            title: 'Fix the\u0000 build \ud83d now',
          },
        },
      ],
    })
    assert.equal(
      importLegacy({
        hydraId: 'odd',
        dir: hydraDir({ hydraId: 'odd' }),
      }),
      true,
    )
    const [events] = query({
      statements: [{ text: 'select data->\'data\'->>\'title\' as title from events where hydra_id = \'odd\'' }],
    })
    assert.deepEqual(
      events,
      [{ title: 'Fix the� build � now' }],
    )
    assert.equal(
      loadHydra({ hydraId: 'odd' }).state.cards['task-odd']?.title,
      'Fix the� build � now',
    )
  },
)

test(
  'a torn legacy tail refuses import and reports the bytes without saving any rows',
  () => {
    seedLog({
      hydraId: 'torn',
      lines: LEGACY_LOG,
    })
    const path = logPath({ dir: hydraDir({ hydraId: 'torn' }) })
    writeFileSync(
      path,
      readFileSync(
        path,
        'utf8',
      ) + '{broken',
    )
    assert.throws(
      () => holdHydra({
        hydraId: 'torn',
        changed: () => {},
      }),
      (error: unknown) => error instanceof HydraError && error.code === 'TORN_TAIL'
      && error.message.includes('7 bytes'),
    )
    assert.deepEqual(
      query({ statements: [{ text: "select id from hydras where id = 'torn'" }] })[0],
      [],
    )
  },
)

test(
  'a legacy import stays within the serializer ceiling while keeping every event in one commit',
  () => {
    const lines = Array.from(
      { length: 1200 },
      (
        _,
        index,
      ) => ({
        v: 1,
        seq: index + 1,
        id: `large-${index}`,
        at: '2026-11-13T00:00:00Z',
        actor: 'cli',
        cardId: 'large',
        type: 'card.pushed',
        data: {
          key: 'large',
          title: `${index}:` + 'x'.repeat(1024),
        },
      }),
    )
    seedLog({
      hydraId: 'large',
      lines,
    })
    const stringify = JSON.stringify
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      const text = stringify(...args)

      if (Array.isArray(args[0]) && text.length > 1024 * 1024) {
        throw new RangeError('serializer ceiling')
      }

      return text
    }) as typeof JSON.stringify

    try {
      const release = holdHydra({
        hydraId: 'large',
        changed: () => {},
      })
      release()
    } finally {
      JSON.stringify = stringify
    }

    assert.equal(
      Number(query({ statements: [{ text: "select count(*) from events where hydra_id = 'large'" }] })[0]![0]!.count),
      1200,
    )
  },
)
