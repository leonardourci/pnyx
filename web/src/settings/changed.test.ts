import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ViewPreferences } from '#preferences/model.ts'
import { DEFAULT_VIEW } from '#preferences/view.ts'
import { SHARED_VIEW_KEYS, type Settings } from '#settings/model.ts'
import { DEFAULT_SETTINGS, patchSettings } from '#settings/settings.ts'
import { changedIds, resetPatch } from './changed.ts'

const viewOf = ({ settings }: { settings: Settings }) => ({
  ...DEFAULT_VIEW,
  ...Object.fromEntries(SHARED_VIEW_KEYS.map(key => [
    key,
    settings[key],
  ])),
}) as ViewPreferences

test(
  'resetting a setting clears it from Changed, including a custom binding, a custom column width and a Hydra setting',
  () => {
    let settings = patchSettings({
      current: DEFAULT_SETTINGS,
      input: {
        theme: 'dark',
        keyboard: { bindings: { 'board.up': ['k'] } },
        defaultColumnWidths: {
          'custom:abc': 500,
          'in_progress': 600,
        },
        helper: 'off',
      },
    })
    assert.deepEqual(
      [
        ...changedIds({
          view: viewOf({ settings }),
          settings,
        }),
      ].sort(),
      [
        'defaultColumnWidths',
        'helper',
        'keyboard',
        'theme',
      ],
    )

    for (const id of [
      'theme',
      'keyboard',
      'defaultColumnWidths',
      'helper',
    ]) {
      settings = patchSettings({
        current: settings,
        input: resetPatch({
          id,
          view: viewOf({ settings }),
        }),
      })
    }

    assert.deepEqual(
      [
        ...changedIds({
          view: viewOf({ settings }),
          settings,
        }),
      ],
      [],
    )
    assert.equal(
      'custom:abc' in settings.defaultColumnWidths,
      false,
    )
  },
)
