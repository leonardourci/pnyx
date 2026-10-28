import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_KEYBOARD, keyboardError, resolveKey, type KeyContext, type KeyInput, type KeyboardPreferences } from './keyboard.ts'

const context: KeyContext = {
  scope: 'hydra',
  platform: 'mac',
  characterShortcuts: true,
  now: 10,
}
const resolve = (
  {
    event,
    change = {},
    prefs = DEFAULT_KEYBOARD,
  }: {
    event: KeyInput
    change?: Partial<KeyContext>
    prefs?: KeyboardPreferences
  },
) => resolveKey({
  event,
  context: {
    ...context,
    ...change,
  },
  prefs,
})

test(
  'scopes, exact modifiers and logical punctuation resolve through tinykeys',
  () => {
    assert.equal(
      keyboardError({ prefs: DEFAULT_KEYBOARD }),
      undefined,
    )
    assert.equal(
      resolve({ event: { key: 'j' } }).action,
      'board.down',
    )
    assert.equal(
      resolve({
        event: {
          key: 'e',
          metaKey: true,
        },
      }).action,
      'card.edit',
    )
    assert.equal(
      resolve({
        event: {
          key: 'e',
          ctrlKey: true,
        },
        change: { platform: 'other' },
      }).action,
      'card.edit',
    )
    assert.equal(
      resolve({ event: { key: 'F2' } }).action,
      'card.edit',
    )
    assert.equal(
      resolve({
        event: { key: 'j' },
        change: { scope: 'thread' },
      }).action,
      'thread.down',
    )
    assert.equal(
      resolve({
        event: { key: 'j' },
        change: { scope: 'navigation' },
      }).consume,
      false,
    )
    assert.equal(
      resolve({
        event: {
          key: 'k',
          metaKey: true,
        },
      }).action,
      'palette',
    )
    assert.equal(
      resolve({
        event: {
          key: 'k',
          ctrlKey: true,
        },
      }).action,
      undefined,
    )
    assert.equal(
      resolve({
        event: {
          key: 'k',
          ctrlKey: true,
        },
        change: { platform: 'other' },
      }).action,
      'palette',
    )
    assert.equal(
      resolve({
        event: {
          key: 'k',
          metaKey: true,
          altKey: true,
        },
      }).consume,
      false,
    )
    assert.equal(
      resolve({
        event: {
          key: '?',
          shiftKey: true,
          code: 'Slash',
        },
      }).action,
      'help',
    )
    assert.equal(
      resolve({
        event: {
          key: '/',
          shiftKey: true,
          code: 'Digit7',
        },
      }).action,
      'search',
    )
  },
)
test(
  'typing, IME, dead keys, AltGraph and repeats cannot activate Hydra commands or send',
  () => {
    for (const scope of [
      'composer',
      'navigation',
    ] as const) {
      for (const key of [
        'j',
        '/',
      ]) {
        assert.equal(
          resolve({
            event: { key },
            change: {
              scope,
              editing: true,
            },
          }).action,
          undefined,
        )
      }
    }

    assert.equal(
      resolve({
        event: { key: 'Enter' },
        change: {
          scope: 'navigation',
          editing: true,
        },
      }).action,
      undefined,
    )
    assert.equal(
      resolve({
        event: { key: 'Enter' },
        change: {
          scope: 'composer',
          editing: true,
        },
      }).action,
      'send',
    )
    assert.equal(
      resolve({
        event: {
          key: 'Enter',
          shiftKey: true,
        },
        change: {
          scope: 'composer',
          editing: true,
        },
      }).action,
      undefined,
    )

    assert.equal(
      resolve({
        event: {
          key: 'k',
          metaKey: true,
        },
        change: {
          scope: 'composer',
          editing: true,
        },
      }).action,
      'palette',
    )

    for (const scope of [
      'composer',
      'overlay',
    ] as const) {
      assert.equal(
        resolve({
          event: { key: 'Escape' },
          change: {
            scope,
            editing: true,
          },
        }).action,
        'cancel',
      )
    }

    assert.equal(
      resolve({
        event: { key: 'Escape' },
        change: {
          scope: 'navigation',
          editing: true,
        },
      }).consume,
      false,
    )
    assert.equal(
      resolve({
        event: { key: 'Escape' },
        change: { scope: 'navigation' },
      }).action,
      'cancel',
    )

    for (const event of [
      {
        key: 'Enter',
        isComposing: true,
      },
      { key: 'Process' },
      { key: 'Dead' },
      {
        key: 'Enter',
        metaKey: true,
        altGraph: true,
      },
      {
        key: 'Enter',
        metaKey: true,
        repeat: true,
      },
      {
        key: 'Enter',
        metaKey: true,
        defaultPrevented: true,
      },
    ]) {
      assert.equal(
        resolve({
          event,
          change: {
            scope: 'composer',
            editing: true,
          },
        }).action,
        undefined,
      )
    }

    assert.equal(
      resolve({
        event: {
          key: 'm',
          repeat: true,
        },
      }).action,
      undefined,
    )
    assert.equal(
      resolve({
        event: {
          key: 'ArrowDown',
          repeat: true,
        },
      }).action,
      'board.down',
    )

    assert.equal(
      resolve({
        event: { key: 'j' },
        change: { characterShortcuts: false },
      }).action,
      undefined,
    )

    assert.equal(
      resolve({
        event: { key: 'ArrowDown' },
        change: { characterShortcuts: false },
      }).action,
      'board.down',
    )
  },
)
test(
  'rebinding validates overlapping scopes and sequence prefixes on both platforms',
  () => {
    const check = ({ bindings }: { bindings: KeyboardPreferences['bindings'] }) => keyboardError({
      prefs: {
        characterShortcuts: true,
        bindings,
      },
    })
    assert.match(
      check({ bindings: { reply: ['j'] } })!,
      /conflicts/,
    )
    assert.match(
      check({ bindings: { reply: ['Control+k'] } })!,
      /conflicts/,
    )
    assert.match(
      check({
        bindings: {
          reply: ['g'],
          'move.left': ['g m'],
        },
      })!,
      /conflicts/,
    )
    assert.match(
      check({ bindings: { send: ['Shift+Enter'] } })!,
      /Shift\+Enter always adds a newline/,
    )
    assert.match(
      check({ bindings: { cancel: ['q'] } })!,
      /Typing must remain literal/,
    )
    assert.match(
      check({ bindings: { cancel: ['Backspace'] } })!,
      /keep editing keys available/,
    )
    assert.equal(
      check({ bindings: { cancel: ['Mod+Escape'] } }),
      undefined,
    )
    assert.match(
      check({ bindings: { reply: ['Mod+w'] } })!,
      /Reserved/,
    )
    assert.match(
      check({ bindings: { reply: ['a b c d'] } })!,
      /three/,
    )
    assert.match(
      check({ bindings: { madeup: [] } })!,
      /Unknown/,
    )
    assert.match(
      check({ bindings: { 'move.left': ['Meta+Mod+m'] } })!,
      /Invalid|modifier|logical/i,
    )
    assert.equal(
      check({
        bindings: {
          'thread.down': ['n'],
          'board.down': ['n'],
        },
      }),
      undefined,
    )
    assert.equal(
      check({
        bindings: {
          reply: ['g r'],
          'move.left': ['g m'],
          search: [],
        },
      }),
      undefined,
    )
    const prefs = {
      characterShortcuts: true,
      bindings: {
        search: ['g s'],
        help: ['g h'],
      },
    }
    const first = resolve({
      event: { key: 'g' },
      change: {},
      prefs,
    }); assert.equal(
      first.consume,
      true,
    ); assert.equal(
      first.action,
      undefined,
    )
    assert.equal(
      resolveKey({
        event: { key: 's' },
        context: {
          ...context,
          now: 500,
        },
        prefs,
        progress: first.progress,
      }).action,
      'search',
    )
    assert.equal(
      resolveKey({
        event: { key: 's' },
        context: {
          ...context,
          now: 1600,
        },
        prefs,
        progress: first.progress,
      }).action,
      undefined,
    )
    assert.equal(
      resolveKey({
        event: { key: 's' },
        context: {
          ...context,
          scope: 'composer',
          editing: true,
        },
        prefs,
        progress: first.progress,
      }).action,
      undefined,
    )
    assert.equal(
      resolve({
        event: { key: 'g' },
        change: { characterShortcuts: false },
        prefs,
      }).consume,
      false,
    )
  },
)
