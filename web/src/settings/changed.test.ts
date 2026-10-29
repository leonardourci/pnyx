import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ViewPreferences } from '#preferences/model.ts'
import { DEFAULT_VIEW } from '#preferences/view.ts'
import type { Settings } from '#settings/model.ts'
import { DEFAULT_SETTINGS, patchSettings } from '#settings/settings.ts'
import { changedIds, resetPatch } from './changed.ts'

const viewOf = ({ settings }: { settings: Settings }) => ({
  ...DEFAULT_VIEW,
  ...settings,
}) as ViewPreferences

test(
  'resetting a setting clears it from Changed, including a custom binding and a custom column width',
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
      },
    })
    assert.deepEqual(
      [...changedIds({ view: viewOf({ settings }) })].sort(),
      [
        'defaultColumnWidths',
        'keyboard',
        'theme',
      ],
    )

    for (const id of [
      'theme',
      'keyboard',
      'defaultColumnWidths',
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
      [...changedIds({ view: viewOf({ settings }) })],
      [],
    )
    assert.equal(
      'custom:abc' in settings.defaultColumnWidths,
      false,
    )
  },
)
