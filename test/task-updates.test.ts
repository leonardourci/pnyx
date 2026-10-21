import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHydra } from '../src/store/hydra-store.ts'
import {
  loadRelevant,
  MAX_PAGES,
  MIN_ROWS,
  relevantUpdate,
  taskTimeline,
  type TaskEvent,
} from '../web/src/hydra/task-updates.ts'

test(
  'task updates retain every declaration, deduplicate history and list relevant events newest first',
  () => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-updates-',
    ))
    process.env.PNYX_HOME = home

    try {
      commands.task([
        'create',
        '--key',
        'example',
        '--title',
        'Check the migration',
        '--column',
        'in_progress',
      ])

      for (const state of [
        'working',
        'needs_you',
        'paused',
        'blocked',
        'done',
      ]) {
        commands.task([
          'status',
          'example',
          state,
          '--note',
          `Status: ${state}`,
        ])
      }

      const state = loadHydra({ hydraId: 'default' }).state
      const card = state.cards[state.keys.example!]!
      const latest = card.statusLog!.at(-1)!
      const initial = card.statusLog![0]!
      const updates = taskTimeline({
        card,
        columns: [],
        events: [
          {
            id: latest.id,
            seq: 6,
            at: latest.at,
            type: 'task.declared',
            summary: '',
            data: { ...latest },
          },
          {
            id: initial.id,
            seq: 1,
            at: initial.at,
            type: 'task.created',
            summary: 'Created task',
          },
          {
            id: 'chat',
            seq: 7,
            at: '2030-01-01T00:00:00Z',
            type: 'chat.message',
            summary: 'Transcript',
          },
        ],
      })

      assert.equal(
        updates.length,
        6,
      )
      assert.equal(
        updates[0]!.state,
        'done',
      )
      assert.equal(
        updates.at(-1)!.id,
        initial.id,
      )
      assert.equal(
        updates.filter(update => update.id === latest.id).length,
        1,
      )
      assert.ok(updates.every(update => update.at && update.state))
    } finally {
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )

      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }
    }
  },
)

test(
  'task updates keep only relevant events and word them plainly',
  () => {
    const columns = [
      {
        id: 'custom:a' as const,
        title: 'In progress',
      },
      {
        id: 'custom:b' as const,
        title: 'Needs you',
      },
    ]
    const shown = ({
      type,
      data,
      summary = '',
    }: {
      type: string
      data: Record<string, unknown>
      summary?: string
    }) => relevantUpdate({
      cardId: 'c1',
      columns,
      event: {
        id: type,
        seq: 1,
        at: '2026-10-21T10:00:00Z',
        type,
        summary,
        data,
      },
    })

    assert.equal(
      shown({
        type: 'card.pushed',
        data: {
          key: 'k',
          activity: 'working',
          settings: { effort: 'high' },
          before: { activity: 'idle' },
        },
      }),
      undefined,
    )
    assert.deepEqual(
      shown({
        type: 'card.pushed',
        data: {
          key: 'k',
          title: 'New name',
          before: { title: 'Old name' },
        },
      }),
      {
        state: 'Renamed',
        note: 'New name',
      },
    )
    assert.deepEqual(
      shown({
        type: 'card.moved',
        data: {
          before: 'custom:a',
          after: 'custom:b',
        },
      }),
      {
        state: 'Moved',
        note: 'In progress → Needs you',
      },
    )
    assert.equal(
      shown({
        type: 'card.linked',
        data: {
          url: 'u',
          before: null,
          after: {
            kind: 'github_pr',
            url: 'u',
            number: 108,
            state: 'merged',
          },
        },
      })?.state,
      'PR #108 merged',
    )
    assert.equal(
      shown({
        type: 'task.session',
        data: {
          session: 's',
          before: 'c0',
          after: 'c1',
        },
      })?.state,
      'Worker attached',
    )
    assert.equal(
      shown({
        type: 'task.session',
        data: {
          session: 's',
          before: 'c1',
          after: null,
        },
      })?.state,
      'Worker detached',
    )

    for (const [
      type,
      data,
    ] of [
        [
          'card.outcome',
          { after: { state: 'ended' } },
        ],
        [
          'card.replied',
          {
            reply: 'r1',
            state: 'delivered',
          },
        ],
        [
          'card.noted',
          {
            kind: 'summary',
            source: 'claude',
          },
        ],
        [
          'task.copy',
          {
            after: {
              state: 'active',
              path: '/tmp/copy',
            },
          },
        ],
      ] as const) {
      assert.equal(
        shown({
          type,
          data,
        }),
        undefined,
        type,
      )
    }
  },
)

test(
  'busy task history pages back until enough relevant rows show, and stops at its end',
  async () => {
    const pageSize = 5
    const event = ({
      seq,
      relevant,
    }: {
      seq: number
      relevant: boolean
    }): TaskEvent => ({
      id: `e${seq}`,
      seq,
      at: '2026-10-21T10:00:00Z',
      type: relevant ? 'task.brief' : 'card.pushed',
      summary: '',
      data: relevant ? {} : {
        key: 'k',
        activity: 'working',
      },
    })
    const history = ({
      total,
      every,
    }: {
      total: number
      every: number
    }) =>
      Array.from(
        { length: total },
        (
          _,
          i,
        ) => event({
          seq: total - i,
          relevant: i % every === 0,
        }),
      )

    const pager = ({ events }: { events: TaskEvent[] }) => {
      const calls: (number | undefined)[] = []

      const load = async ({ before }: { before?: number }) => {
        calls.push(before)

        return events.filter(e => before === undefined || e.seq < before).slice(
          0,
          pageSize,
        )
      }

      return {
        calls,
        load,
      }
    }

    const short = pager({
      events: history({
        total: 3,
        every: 10,
      }),
    })
    const ended = await loadRelevant({
      cardId: 'c1',
      pageSize,
      load: short.load,
    })
    assert.deepEqual(
      [
        short.calls.length,
        ended.more,
      ],
      [
        1,
        false,
      ],
    )

    const sparse = pager({
      events: history({
        total: 1000,
        every: 2,
      }),
    })
    const enough = await loadRelevant({
      cardId: 'c1',
      pageSize,
      load: sparse.load,
    })
    assert.ok(enough.found.filter(e => e.type === 'task.brief').length >= MIN_ROWS)
    assert.equal(
      enough.more,
      true,
    )
    assert.equal(
      sparse.calls.length,
      Math.ceil(MIN_ROWS * 2 / pageSize),
    )

    const noise = pager({
      events: history({
        total: 1000,
        every: 1000,
      }),
    })
    const capped = await loadRelevant({
      cardId: 'c1',
      before: 900,
      pageSize,
      load: noise.load,
    })
    assert.equal(
      noise.calls.length,
      MAX_PAGES,
    )
    assert.equal(
      noise.calls[0],
      900,
    )
    assert.equal(
      capped.more,
      true,
    )
  },
)
