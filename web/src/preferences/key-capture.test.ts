import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_KEYBOARD, resolveKey } from '#preferences/keyboard.ts'
import { capturedKey } from './key-capture.ts'

test(
  'captured shortcuts preserve modifiers and resolve the same key press',
  () => {
    const shifted = {
      key: 'J',
      shiftKey: true,
    }
    const alternate = {
      key: 'x',
      altKey: true,
    }
    assert.equal(
      capturedKey({ event: shifted }),
      'Shift+j',
    )
    assert.equal(
      capturedKey({ event: alternate }),
      'Alt+x',
    )
    assert.equal(
      capturedKey({
        event: {
          key: 'J',
          ctrlKey: true,
          metaKey: true,
          altKey: true,
          shiftKey: true,
        },
      }),
      'Control+Meta+Alt+Shift+j',
    )
    assert.equal(
      capturedKey({
        event: {
          key: '?',
          shiftKey: true,
        },
      }),
      'Shift+?',
    )
    assert.equal(
      capturedKey({
        event: {
          key: '+',
          shiftKey: true,
        },
      }),
      'Shift++',
    )
    const prefs = {
      ...DEFAULT_KEYBOARD,
      bindings: {
        'board.down': [
          capturedKey({ event: shifted }),
          capturedKey({ event: alternate }),
        ],
      },
    }
    const context = {
      scope: 'hydra' as const,
      platform: 'mac' as const,
      characterShortcuts: true,
      now: 1,
    }
    assert.equal(
      resolveKey({
        event: shifted,
        prefs,
        context,
      }).action,
      'board.down',
    )
    assert.equal(
      resolveKey({
        event: alternate,
        prefs,
        context,
      }).action,
      'board.down',
    )
    assert.equal(
      resolveKey({
        event: { key: 'j' },
        prefs,
        context,
      }).action,
      undefined,
    )
  },
)
