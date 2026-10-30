import assert from 'node:assert/strict'
import { test } from 'node:test'
import { movedId, paletteKey, selectedId } from './keys.ts'

const press = ({
  key,
  shift = false,
  mod = false,
  composing = false,
  pending = false,
  token,
  query = 'deploy',
  onAction = false,
}: {
  key: string
  shift?: boolean
  mod?: boolean
  composing?: boolean
  pending?: boolean
  token?: string
  query?: string
  onAction?: boolean
}) => paletteKey({
  key,
  shift,
  mod,
  composing,
  pending,
  token,
  query,
  onAction,
})

test(
  'Enter opens the selected result, Mod+Enter opens it elsewhere, and both wait while the answer is pending',
  () => {
    assert.equal(
      press({ key: 'Enter' }),
      'open',
    )
    assert.equal(
      press({
        key: 'Enter',
        mod: true,
      }),
      'open-elsewhere',
    )

    for (const key of [
      'Enter',
      'ArrowDown',
      'ArrowUp',
    ]) {
      assert.equal(
        press({
          key,
          pending: true,
        }),
        'wait',
        `${key} waits so it never acts on results about to be replaced`,
      )
    }
  },
)

test(
  'Escape clears the text first and closes once the field is empty',
  () => {
    assert.equal(
      press({ key: 'Escape' }),
      'clear',
    )
    assert.equal(
      press({
        key: 'Escape',
        query: '',
      }),
      'close',
    )
  },
)

test(
  'with a half-typed filter, Space, Tab and Enter make the badge, the arrows move in the menu and Escape drops the filter',
  () => {
    for (const key of [
      ' ',
      'Tab',
      'Enter',
    ]) {
      assert.equal(
        press({
          key,
          token: '>prog',
          pending: true,
        }),
        'commit',
      )
    }

    assert.equal(
      press({
        key: 'ArrowDown',
        token: '>prog',
        pending: true,
      }),
      'down',
      'the menu is local, so it never waits for the search',
    )
    assert.equal(
      press({
        key: 'Escape',
        token: '>prog',
      }),
      'drop-filter',
    )
    assert.equal(
      press({
        key: ' ',
        token: '>',
      }),
      null,
      'a space after a bare > is typed',
    )
    assert.equal(
      press({
        key: 'Tab',
        shift: true,
        token: '>prog',
      }),
      null,
    )
  },
)

test(
  'Tab is left to the palette’s focus cycle, typing stays in the field, and no key acts while an IME is composing',
  () => {
    assert.equal(
      press({ key: 'Tab' }),
      null,
    )
    assert.equal(
      press({
        key: 'Tab',
        shift: true,
      }),
      null,
    )
    assert.equal(
      press({ key: 'd' }),
      null,
    )

    for (const key of [
      'Enter',
      'Escape',
      'ArrowDown',
      ' ',
    ]) {
      assert.equal(
        press({
          key,
          composing: true,
          token: key === ' ' ? '>prog' : undefined,
        }),
        null,
      )
    }
  },
)

test(
  'a refresh of the same query keeps the chosen result, and a new query or a vanished result selects the top one',
  () => {
    const chosen = {
      key: 'deploy',
      id: 'task:b',
    }

    assert.equal(
      selectedId({
        ids: [
          'task:a',
          'task:b',
        ],
        chosen,
        key: 'deploy',
      }),
      'task:b',
    )
    assert.equal(
      selectedId({
        ids: [
          'task:c',
          'task:b',
        ],
        chosen,
        key: 'deploy',
      }),
      'task:b',
      'the selection follows the result, not its place',
    )
    assert.equal(
      selectedId({
        ids: [
          'task:a',
          'task:b',
        ],
        chosen,
        key: 'deploy staging',
      }),
      'task:a',
    )
    assert.equal(
      selectedId({
        ids: ['task:a'],
        chosen,
        key: 'deploy',
      }),
      'task:a',
    )
  },
)

test(
  'the arrows step through the results and stop at either end',
  () => {
    const ids = [
      'a',
      'b',
      'c',
    ]

    assert.equal(
      movedId({
        ids,
        current: 'a',
        step: 1,
      }),
      'b',
    )
    assert.equal(
      movedId({
        ids,
        current: 'c',
        step: 1,
      }),
      'c',
    )
    assert.equal(
      movedId({
        ids,
        current: 'a',
        step: -1,
      }),
      'a',
    )
  },
)

test(
  'on an action in the > menu, Enter runs it, Space does nothing and Tab is the focus cycle’s; on a filter they make the badge',
  () => {
    const onAction = ({
      key,
      mod = false,
    }: {
      key: string
      mod?: boolean
    }) => press({
      key,
      mod,
      token: '>col',
      query: '>col',
      onAction: true,
    })

    assert.equal(
      onAction({ key: 'Enter' }),
      'open',
    )
    assert.equal(
      onAction({
        key: 'Enter',
        mod: true,
      }),
      'open-elsewhere',
    )
    assert.equal(
      onAction({ key: 'Tab' }),
      null,
    )
    assert.equal(
      onAction({ key: ' ' }),
      'commit',
      'a commit with no filter selected keeps the space out of the token and does nothing else',
    )
    assert.equal(
      onAction({ key: 'ArrowDown' }),
      'down',
    )
    assert.equal(
      press({
        key: 'Enter',
        token: '>col',
        query: '>col',
      }),
      'commit',
    )
  },
)
