import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lookupMessages, type MessageSelection } from './message-lookup.ts'
import { lookupEntries, lookupEvents } from '#hydra/fixtures/message-lookup.ts'

test(
  'native replies take the seq of the event before them, so snapshots bound them and a shared seq needs an id',
  () => {
    const second = {
      ...lookupEntries[4],
      id: '4:m1',
      reference: 'original:4:m1',
      text: 'A second reply after the same event.',
      at: '2026-01-01T00:00:04.750Z',
    }
    const read = ({
      selection,
      snapshot = 9,
    }: {
      selection: MessageSelection
      snapshot?: number
    }) => lookupMessages({
      hydraId: 'fixture',
      events: lookupEvents,
      entries: [
        ...lookupEntries,
        second,
      ],
      snapshot,
      selection,
    })
    assert.deepEqual(
      read({ selection: { id: second.reference } }).messages.map(message => [
        message.seq,
        message.text,
      ]),
      [
        [
          5,
          'A second reply after the same event.',
        ],
      ],
    )
    assert.throws(
      () => read({ selection: { seq: 5 } }),
      /Several messages match; use --id/,
    )
    assert.deepEqual(
      read({
        selection: {},
        snapshot: 2,
      }).messages.map(message => message.text),
      [
        'Recorded reply 1.',
        'Recorded reply 2.',
      ],
    )
  },
)
