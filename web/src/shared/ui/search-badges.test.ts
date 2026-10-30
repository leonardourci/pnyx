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
  '← with nothing marked marks the last badge and → moves the mark on, then past the last back to the text',
  () => {
    assert.deepEqual(
      badgeKey({
        key: 'ArrowLeft',
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
        key: 'ArrowRight',
        marked: 0,
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
  },
)

test(
  'keys away from the start, with no badges, or with nothing to act on stay with the field',
  () => {
    assert.deepEqual(
      badgeKey({
        key: 'Backspace',
        count: 2,
        atStart: false,
      }),
      { handled: false },
    )
    assert.deepEqual(
      badgeKey({
        key: 'Backspace',
        count: 0,
        atStart: true,
      }),
      { handled: false },
    )
    assert.deepEqual(
      badgeKey({
        key: 'ArrowRight',
        count: 2,
        atStart: true,
      }),
      { handled: false },
    )
    assert.deepEqual(
      badgeKey({
        key: 'Delete',
        count: 2,
        atStart: true,
      }),
      { handled: false },
    )
    assert.deepEqual(
      badgeKey({
        key: 'a',
        marked: 1,
        count: 2,
        atStart: true,
      }),
      { handled: false },
    )
  },
)
