import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { commit } from '#app/cli-support.ts'
import { decideView } from '#preferences/decisions.ts'
import { cardDoneDeadline, HOUR_MS } from '#tasks/retention-rules.ts'
import type { Card } from '#tasks/model.ts'
import { settingsLogPath } from './store.ts'
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
  process.env.PNYX_HOME = realpathSync(mkdtempSync(join(
    scratch,
    'pnyx-settings-',
  )))
}

// Writes a Hydra's own view the way releases before shared settings did, without touching the store.
function legacyView({
  hydraId,
  patch,
}: {
  hydraId: string
  patch: Record<string, unknown>
}) {
  const meta = {
    at: new Date().toISOString(),
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
  'the first read moves the values of the Hydra changed most recently',
  async () => {
    home()
    await commands.hydra([
      'create',
      'older',
    ])
    await commands.hydra([
      'create',
      'newer',
    ])
    legacyView({
      hydraId: 'older',
      patch: { theme: 'light' },
    })
    legacyView({
      hydraId: 'newer',
      patch: {
        theme: 'dark',
        defaultHydraWidth: 600,
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
      moved.revision,
      1,
    )
    assert.match(
      readFileSync(
        settingsLogPath(),
        'utf8',
      ),
      /Moved from Hydra newer/,
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
      /takes off or hours/,
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
      /unknown keys panelWidth/,
    )
    const save = () => commands.settings([
      'set',
      '--json',
      '{"focusMode":false}',
      '--event-id',
      'one',
    ])
    await save()
    const saved = await settings()
    await save()
    assert.equal(
      (await settings()).revision,
      saved.revision,
    )
    assert.throws(
      () => commands.settings([
        'set',
        '--json',
        '{"focusMode":true}',
        '--if-revision',
        String(saved.revision - 1),
      ]),
      /settings changed/,
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
        card,
        hours: 2,
      }),
      Date.parse(doneAt) + 2 * HOUR_MS,
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
