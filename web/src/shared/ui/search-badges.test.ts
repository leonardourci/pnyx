import assert from 'node:assert/strict'
import { test } from 'node:test'
import { badgeKey } from './search-badges.ts'

test(
  'at the start of the field ⌫ marks the last badge and removes it on the second press, and arrows move the mark',
  () => {
    assert.deepEqual(
      badgeKey({
        key: 'Backspace',
        count: 3,
        atStart: true,
      }),
      {
        marked: 2,
        handled: true,
      },
    )
    assert.deepEqual(
      badgeKey({
        key: 'Backspace',
        marked: 2,
        count: 3,
        atStart: true,
      }),
      {
        remove: 2,
        handled: true,
      },
    )
    assert.deepEqual(
      badgeKey({
        key: 'ArrowLeft',
        marked: 2,
        count: 3,
        atStart: true,
      }),
      {
        marked: 1,
        handled: true,
      },
    )
    assert.deepEqual(
      badgeKey({
        key: 'ArrowLeft',
        marked: 0,
        count: 3,
        atStart: true,
      }),
      {
        marked: 0,
        handled: true,
      },
    )
    assert.deepEqual(
      badgeKey({
        key: 'Delete',
        marked: 1,
        count: 3,
        atStart: true,
      }),
      {
        remove: 1,
        handled: true,
      },
    )
  },
)

test(
  '→ past the last badge returns to the text, and keys away from the start or without badges stay with the field',
  () => {
    assert.deepEqual(
      badgeKey({
        key: 'ArrowRight',
        marked: 2,
        count: 3,
        atStart: true,
      }),
      {
        marked: undefined,
        handled: true,
      },
    )

    for (const pressed of [
      {
        key: 'Backspace',
        count: 2,
        atStart: false,
      },
      {
        key: 'Backspace',
        count: 0,
        atStart: true,
      },
      {
        key: 'ArrowRight',
        count: 2,
        atStart: true,
      },
      {
        key: 'Delete',
        count: 2,
        atStart: true,
      },
      {
        key: 'a',
        marked: 1,
        count: 2,
        atStart: true,
      },
    ]) {
      assert.deepEqual(
        badgeKey(pressed),
        { handled: false },
        pressed.key,
      )
    }
  },
)
