import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { commit } from '#app/cli-support.ts'
import { loadHydra } from '#app/store.ts'
import { hydraConfig } from '#hydra/config.ts'
import type { HydraConfig } from '#hydra/model.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { decideView } from '#preferences/decisions.ts'
import { hideDone } from '#tasks/retention.ts'
import { cardDoneDeadline, HOUR_MS } from '#tasks/retention-rules.ts'
import type { Card } from '#tasks/model.ts'
import { settingsLogPath } from './store.ts'
import { hydraDir } from '#app/home-migration.ts'
import { acquireLock } from '#store/storage.ts'
import type { Settings } from './model.ts'

const scratch = mkdtempSync(join(
  tmpdir(),
  'pnyx-test-',
))
after(() => rmSync(
  scratch,
  {
    recursive: true,
    force: true,
  },
))

function home() {
  const dir = realpathSync(mkdtempSync(join(
    scratch,
    'pnyx-settings-',
  )))
  process.env.PNYX_HOME = dir

  return dir
}

// Writes a Hydra's own view the way releases before shared settings did, without touching the store.
function legacyView({
  hydraId,
  at,
  patch,
}: {
  hydraId: string
  at: string
  patch: Record<string, unknown>
}) {
  const meta = {
    at,
    actor: 'cli',
  }

  return commit({
    hydraId,
    meta,
    intent: {
      type: 'board.view',
      card: '$board',
    },
    decide: ({ state }) => decideView({
      state,
      patch,
      meta,
    }),
  })
}

// Writes a Hydra's own config the way releases before shared settings did.
// drop removes a value, as an old reset to the default such as `hydra set --helper auto` did.
function legacyConfig({
  hydraId,
  at,
  data,
  drop = [],
}: {
  hydraId: string
  at: string
  data: Record<string, unknown>
  drop?: string[]
}) {
  const meta = {
    at,
    actor: 'cli',
  }

  return commit({
    hydraId,
    meta,
    intent: {
      type: 'board.configured',
      card: '$board',
    },
    decide: ({ state }) => hydraEvent({
      state,
      meta,
      cardId: '$board',
      change: {
        type: 'board.configured',
        data: Object.fromEntries(Object.entries({
          ...hydraConfig({
            state,
            id: hydraId,
          }),
          ...data,
        }).filter(([key]) => !drop.includes(key))) as unknown as HydraConfig,
      },
    }),
  })
}

const show = async ({ hydraId }: { hydraId: string }) =>
  (await commands.view([
    'show',
    '--hydra',
    hydraId,
  ])) as { view: Record<string, unknown> }

const settings = async () => (await commands.settings(['show'])) as {
  settings: Settings
  revision: number
}

const cardOf = ({
  hydraId,
  key,
}: {
  hydraId: string
  key: string
}) => {
  const { state } = loadHydra({ hydraId })

  return state.cards[state.keys[key]!]!
}

async function doneCard({
  dir,
  hydraId,
  key,
}: {
  dir: string
  hydraId: string
  key: string
}) {
  const file = join(
    dir,
    `${key}.json`,
  )
  writeFileSync(
    file,
    JSON.stringify({ title: key }),
  )
  await commands.push([
    '--key',
    key,
    '--file',
    file,
    '--hydra',
    hydraId,
  ])
  await commands.outcome([
    key,
    'done',
    '--hydra',
    hydraId,
  ])

  return Date.parse(cardOf({
    hydraId,
    key,
  }).doneAt!)
}

test(
  'a shared preference saved in one Hydra shows in every Hydra, and layout stays with its board',
  async () => {
    home()
    await commands.hydra([
      'create',
      'first',
    ])
    await commands.hydra([
      'create',
      'second',
    ])
    await commands.view([
      'set',
      '--json',
      '{"theme":"dark","fontSize":16,"hydraWidth":600}',
      '--hydra',
      'first',
    ])

    const second = await show({ hydraId: 'second' })
    assert.equal(
      second.view.theme,
      'dark',
    )
    assert.equal(
      second.view.fontSize,
      16,
    )
    assert.equal(
      second.view.hydraWidth,
      480,
    )
    assert.equal(
      (await show({ hydraId: 'first' })).view.hydraWidth,
      600,
    )
  },
)

test(
  'the first read takes the view changed last and each Hydra value set last, turning an old 0 into off',
  async () => {
    home()
    await commands.hydra([
      'create',
      'beta',
    ])
    await commands.hydra([
      'create',
      'alpha',
    ])
    legacyView({
      hydraId: 'alpha',
      at: '2026-01-01T00:00:00.000Z',
      patch: { theme: 'light' },
    })
    legacyView({
      hydraId: 'beta',
      at: '2026-02-01T00:00:00.000Z',
      patch: {
        theme: 'dark',
        defaultHydraWidth: 600,
      },
    })
    legacyConfig({
      hydraId: 'alpha',
      at: '2026-03-01T00:00:00.000Z',
      data: {
        doneAfterHours: 0,
        reviewMinutes: 5,
        helper: false,
      },
    })

    const moved = await settings()
    assert.equal(
      moved.settings.theme,
      'dark',
    )
    assert.equal(
      moved.settings.defaultHydraWidth,
      600,
    )
    assert.equal(
      moved.settings.doneAfterHours,
      'off',
    )
    assert.equal(
      moved.settings.reviewMinutes,
      5,
    )
    assert.equal(
      moved.settings.helper,
      'off',
    )
    assert.equal(
      moved.revision,
      1,
    )
  },
)

test(
  'an old reset to the default counts as the Hydra changing that value, so the newest change across Hydras wins',
  async () => {
    home()
    await commands.hydra([
      'create',
      'alpha',
    ])
    await commands.hydra([
      'create',
      'beta',
    ])
    legacyView({
      hydraId: 'alpha',
      at: '2026-01-01T00:00:00.000Z',
      patch: { defaultHydraWidth: 360 },
    })
    legacyConfig({
      hydraId: 'alpha',
      at: '2026-01-01T00:00:00.000Z',
      data: {
        helper: false,
        reviewMinutes: 5,
      },
    })
    legacyConfig({
      hydraId: 'beta',
      at: '2026-01-15T00:00:00.000Z',
      data: { reviewMinutes: 12 },
    })
    legacyConfig({
      hydraId: 'alpha',
      at: '2026-02-01T00:00:00.000Z',
      data: { reviewMinutes: 5 },
      drop: ['helper'],
    })

    const moved = await settings()
    assert.equal(
      moved.settings.helper,
      'auto',
    )
    assert.equal(
      moved.settings.reviewMinutes,
      12,
    )
    // An older release saved 360 as its default Hydra width, so it moves as today's default.
    assert.equal(
      moved.settings.defaultHydraWidth,
      480,
    )
  },
)

test(
  'widths an older release used as defaults keep their value as shared settings through an unrelated edit',
  async () => {
    home()
    await commands.hydra([
      'create',
      'alpha',
    ])
    await commands.settings([
      'set',
      '--json',
      JSON.stringify({
        defaultHydraWidth: 360,
        defaultColumnWidths: { in_progress: 290 },
      }),
    ])
    await commands.settings([
      'set',
      '--json',
      '{"fontSize":17}',
    ])

    const saved = await settings()
    assert.equal(
      saved.settings.defaultHydraWidth,
      360,
    )
    assert.equal(
      saved.settings.defaultColumnWidths.in_progress,
      290,
    )
    const { view } = await show({ hydraId: 'alpha' })
    assert.equal(
      view.defaultHydraWidth,
      360,
    )
    assert.equal(
      (view.defaultColumnWidths as Record<string, number>).in_progress,
      290,
    )
  },
)

test(
  'hydra set flags write the shared settings, with off keeping Done cards and 0 hiding them right away',
  async () => {
    home()
    await commands.hydra([
      'create',
      'main',
    ])
    await commands.hydra([
      'set',
      '--done-after-hours',
      'off',
      '--review-minutes',
      '45',
      '--helper',
      'codex',
      '--helper-model',
      'gpt-6-luna',
      '--hydra',
      'main',
    ])
    const shared = (await settings()).settings
    assert.equal(
      shared.doneAfterHours,
      'off',
    )
    assert.equal(
      shared.reviewMinutes,
      45,
    )
    assert.deepEqual(
      shared.helper,
      {
        harness: 'codex',
        model: 'gpt-6-luna',
      },
    )

    await commands.hydra([
      'set',
      '--done-after-hours',
      '0',
      '--hydra',
      'main',
    ])
    assert.equal(
      (await settings()).settings.doneAfterHours,
      0,
    )
    assert.throws(
      () => commands.hydra([
        'set',
        '--done-after-hours',
        'never',
        '--hydra',
        'main',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
  },
)

test(
  'a refused command leaves the shared settings as they were',
  async () => {
    home()
    await commands.hydra([
      'create',
      'main',
    ])
    const before = await settings()

    assert.throws(
      () => commands.view([
        'set',
        '--json',
        '{"theme":"dark","hydraWidth":600}',
        '--if-revision',
        '5',
        '--hydra',
        'main',
      ]),
      { code: 'REVISION_CONFLICT' },
    )
    assert.throws(
      () => commands.view([
        'set',
        '--json',
        '{"fontSize":18,"panelWidth":-5}',
        '--hydra',
        'main',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
    assert.throws(
      () => commands.hydra([
        'create',
        'main',
        '--name',
        'Other',
        '--helper',
        'claude',
      ]),
      { code: 'CONFLICT' },
    )
    assert.deepEqual(
      await settings(),
      before,
    )
  },
)

test(
  'settings set refuses unknown keys and stale revisions, and a repeated event id saves once',
  async () => {
    home()
    assert.throws(
      () => commands.settings([
        'set',
        '--json',
        '{"panelWidth":500}',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
    await commands.settings([
      'set',
      '--json',
      '{"focusMode":false}',
      '--event-id',
      'one',
    ])
    const saved = await settings()
    const repeat = await commands.settings([
      'set',
      '--json',
      '{"focusMode":true}',
      '--event-id',
      'one',
    ])

    assert.equal(
      repeat.event,
      'none: duplicate',
    )
    assert.deepEqual(
      await settings(),
      saved,
    )
    assert.throws(
      () => commands.settings([
        'set',
        '--json',
        '{"focusMode":true}',
        '--if-revision',
        '0',
      ]),
      { code: 'REVISION_CONFLICT' },
    )
  },
)

test(
  'retrying an attempt that changed nothing returns without undoing a newer edit, through settings set and view set',
  async () => {
    home()
    await commands.hydra([
      'create',
      'alpha',
    ])
    const settingsAttempt = [
      'set',
      '--json',
      '{"theme":"system"}',
      '--event-id',
      'retry-noop-settings',
    ]
    await commands.settings(settingsAttempt)
    await commands.settings([
      'set',
      '--json',
      '{"theme":"dark"}',
    ])
    await commands.settings(settingsAttempt)
    assert.equal(
      (await settings()).settings.theme,
      'dark',
    )

    const viewAttempt = [
      'set',
      '--json',
      '{"theme":"dark"}',
      '--event-id',
      'retry-noop-view',
      '--hydra',
      'alpha',
    ]
    await commands.view(viewAttempt)
    await commands.settings([
      'set',
      '--json',
      '{"theme":"light"}',
    ])
    await commands.view(viewAttempt)
    const after = await settings()
    assert.equal(
      after.settings.theme,
      'light',
    )
    assert.equal(
      after.revision,
      2,
    )
  },
)

test(
  'the Oracle filter choice and the Hydra order are shared settings, checked before they save',
  async () => {
    home()
    await commands.settings([
      'set',
      '--json',
      JSON.stringify({
        oracleRememberFilters: true,
        hydraOrder: [
          'zeus',
          'athena',
        ],
      }),
    ])
    await commands.settings([
      'set',
      '--json',
      '{"hydraOrder":["athena","zeus","hera"]}',
    ])
    const saved = await settings()
    assert.equal(
      saved.settings.oracleRememberFilters,
      true,
    )
    assert.deepEqual(
      saved.settings.hydraOrder,
      [
        'athena',
        'zeus',
        'hera',
      ],
    )
    await assert.rejects(
      async () => commands.settings([
        'set',
        '--json',
        '{"hydraOrder":["zeus","zeus"]}',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      async () => commands.settings([
        'set',
        '--json',
        '{"oracleRememberFilters":"yes"}',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      async () => commands.settings([
        'set',
        '--json',
        '{"hydraOrder":["../x"]}',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      async () => commands.settings([
        'set',
        '--json',
        '{"hydraOrder":"zeus"}',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
    assert.equal(
      (await settings()).revision,
      saved.revision,
    )
  },
)

test(
  'hydra set with a Hydra flag and a shared setting saves both',
  async () => {
    home()
    await commands.hydra([
      'create',
      'alpha',
    ])
    await commands.hydra([
      'set',
      '--name',
      'Athena',
      '--review-minutes',
      '7',
      '--hydra',
      'alpha',
    ])
    assert.equal(
      loadHydra({ hydraId: 'alpha' }).state.config?.name,
      'Athena',
    )
    assert.equal(
      (await settings()).settings.reviewMinutes,
      7,
    )
  },
)

test(
  'layout reset moves old settings before it takes the Hydra writer, so it never waits for the shared lock while holding it',
  async () => {
    const dir = home()
    await commands.hydra([
      'create',
      'alpha',
    ])
    legacyView({
      hydraId: 'alpha',
      at: '2026-01-01T00:00:00.000Z',
      patch: { theme: 'dark' },
    })
    rmSync(
      settingsLogPath(),
      { force: true },
    )
    const writerLock = join(
      hydraDir({ hydraId: 'alpha' }),
      'writer.lock',
    )
    const release = acquireLock({ dir })
    const reset = spawn(
      process.execPath,
      [
        '--conditions=source',
        'src/cli/pnyx-axi.ts',
        'layout',
        'reset',
        '--hydra',
        'alpha',
      ],
      { env: process.env },
    )
    let held = false
    const watch = setInterval(
      () => {
        if (existsSync(writerLock)) {
          held = true
        }
      },
      20,
    )
    await once(
      reset,
      'exit',
    )
    clearInterval(watch)
    release()
    assert.equal(
      held,
      false,
    )
    await commands.layout([
      'reset',
      '--hydra',
      'alpha',
    ])
    assert.equal(
      (await settings()).settings.theme,
      'dark',
    )
  },
)

test(
  'a save after a torn last line is kept',
  async () => {
    home()
    await commands.settings([
      'set',
      '--json',
      '{"fontSize":15}',
    ])
    appendFileSync(
      settingsLogPath(),
      '{"torn',
    )
    await commands.settings([
      'set',
      '--json',
      '{"fontSize":16}',
    ])

    const read = await settings()
    assert.equal(
      read.settings.fontSize,
      16,
    )
    assert.equal(
      read.revision,
      2,
    )
  },
)

test(
  'the shared column fallback reaches other Hydras and future columns while preserving overrides',
  async () => {
    home()
    await commands.hydra([
      'create',
      'first',
    ])
    await commands.hydra([
      'create',
      'second',
    ])
    const first = hydraConfig({
      state: loadHydra({ hydraId: 'first' }).state,
      id: 'first',
    }).columns[0]!.id
    const second = hydraConfig({
      state: loadHydra({ hydraId: 'second' }).state,
      id: 'second',
    }).columns[0]!.id
    await commands.settings([
      'set',
      '--json',
      '{"defaultColumnWidth":460}',
    ])
    assert.equal(
      ((await show({ hydraId: 'first' })).view.defaultColumnWidths as Record<string, number>)[first],
      460,
    )
    assert.equal(
      ((await show({ hydraId: 'second' })).view.defaultColumnWidths as Record<string, number>)[second],
      460,
    )
    await commands.column([
      'create',
      '--title',
      'Future',
      '--id',
      'custom:future',
      '--hydra',
      'second',
    ])
    assert.equal(
      ((await show({ hydraId: 'second' })).view.defaultColumnWidths as Record<string, number>)['custom:future'],
      460,
    )
    await commands.settings([
      'set',
      '--json',
      JSON.stringify({ defaultColumnWidths: { [first]: 510 } }),
    ])
    await commands.column([
      'resize',
      second,
      '--width',
      '650',
      '--hydra',
      'second',
    ])
    await commands.settings([
      'set',
      '--json',
      '{"defaultColumnWidth":480}',
    ])
    assert.equal(
      ((await show({ hydraId: 'first' })).view.defaultColumnWidths as Record<string, number>)[first],
      510,
    )
    assert.equal(
      ((await show({ hydraId: 'second' })).view.columnWidths as Record<string, number>)[second],
      650,
    )
    await commands.layout([
      'reset',
      '--all',
    ])
    assert.equal(
      ((await show({ hydraId: 'second' })).view.columnWidths as Record<string, number>)[second],
      undefined,
    )
    await commands.settings([
      'set',
      '--json',
      '{"defaultColumnWidth":490}',
    ])
    assert.equal(
      ((await show({ hydraId: 'second' })).view.defaultColumnWidths as Record<string, number>)[second],
      490,
    )
  },
)

test(
  'layout reset --all returns every Hydra to the shared default widths once',
  async () => {
    home()

    for (const hydraId of [
      'first',
      'second',
    ]) {
      await commands.hydra([
        'create',
        hydraId,
      ])
      await commands.view([
        'set',
        '--json',
        '{"hydraWidth":700}',
        '--hydra',
        hydraId,
      ])
    }

    await commands.settings([
      'set',
      '--json',
      '{"defaultHydraWidth":520}',
    ])
    await commands.layout([
      'reset',
      '--all',
      '--event-id',
      'reset-1',
    ])
    await commands.view([
      'set',
      '--json',
      '{"hydraWidth":700}',
      '--hydra',
      'second',
    ])
    await commands.layout([
      'reset',
      '--all',
      '--event-id',
      'reset-1',
    ])

    assert.equal(
      (await show({ hydraId: 'first' })).view.hydraWidth,
      520,
    )
    assert.equal(
      (await show({ hydraId: 'second' })).view.hydraWidth,
      700,
    )
    assert.throws(
      () => commands.layout([
        'reset',
        '--all',
        '--if-revision',
        '1',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
  },
)

test(
  'Done cards follow the shared hours, while a task\'s own 0 keeps it visible',
  async () => {
    const dir = home()
    await commands.hydra([
      'create',
      'main',
    ])
    const doneAt = await doneCard({
      dir,
      hydraId: 'main',
      key: 'ship',
    })
    await doneCard({
      dir,
      hydraId: 'main',
      key: 'keep',
    })
    await commands.task([
      'hide-after',
      'keep',
      '0',
      '--hydra',
      'main',
    ])
    await commands.settings([
      'set',
      '--json',
      '{"doneAfterHours":2}',
    ])

    assert.equal(
      hideDone({
        hydraId: 'main',
        at: new Date(doneAt + 2 * HOUR_MS - 1).toISOString(),
      }),
      0,
    )
    assert.equal(
      hideDone({
        hydraId: 'main',
        at: new Date(doneAt + 2 * HOUR_MS).toISOString(),
      }),
      1,
    )
    assert.equal(
      cardOf({
        hydraId: 'main',
        key: 'ship',
      }).hidden,
      true,
    )
    assert.equal(
      cardOf({
        hydraId: 'main',
        key: 'keep',
      }).hidden,
      undefined,
    )

    await doneCard({
      dir,
      hydraId: 'main',
      key: 'later',
    })
    await commands.settings([
      'set',
      '--json',
      '{"doneAfterHours":"off"}',
    ])
    assert.equal(
      hideDone({
        hydraId: 'main',
        at: new Date(doneAt + 1000 * HOUR_MS).toISOString(),
      }),
      0,
    )
  },
)

test(
  'a task keeps its own 0 as visible, while the shared hours decide the rest',
  () => {
    const doneAt = '2026-10-29T10:00:00.000Z'
    const card = { doneAt } as unknown as Card

    assert.equal(
      cardDoneDeadline({
        card,
        hours: 'off',
      }),
      undefined,
    )
    assert.equal(
      cardDoneDeadline({
        card,
        hours: 0,
      }),
      Date.parse(doneAt),
    )
    assert.equal(
      cardDoneDeadline({
        card: {
          ...card,
          doneAfterHours: 0,
        },
        hours: 2,
      }),
      undefined,
    )
  },
)
