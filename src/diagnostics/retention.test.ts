import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keptDays } from './retention.ts'

const MB = 1024 * 1024

test(
  'a cleanup keeps the last days that fit the cap, deletes the oldest first, and never deletes today',
  () => {
    const cases = [
      {
        what: 'every day within the days and the cap',
        days: {
          '2026-03-08': 0.2,
          '2026-03-09': 0.2,
          '2026-03-10': 0.2,
        },
        keepDays: 7,
        kept: [
          '2026-03-08',
          '2026-03-09',
          '2026-03-10',
        ],
        full: false,
        overfull: false,
      },
      {
        what: 'days past the kept ones',
        days: {
          '2026-03-01': 0.1,
          '2026-03-08': 0.1,
          '2026-03-10': 0.1,
        },
        keepDays: 3,
        kept: [
          '2026-03-08',
          '2026-03-10',
        ],
        full: false,
        overfull: false,
      },
      {
        what: 'older days past the cap, oldest first, even one that would fit after a larger one',
        days: {
          '2026-03-05': 0.05,
          '2026-03-06': 0.3,
          '2026-03-07': 0.2,
          '2026-03-08': 0.3,
          '2026-03-09': 0.2,
          '2026-03-10': 0.2,
        },
        keepDays: 7,
        kept: [
          '2026-03-07',
          '2026-03-08',
          '2026-03-09',
          '2026-03-10',
        ],
        full: false,
        overfull: false,
      },
      {
        what: 'today alone past the cap',
        days: {
          '2026-03-09': 0.1,
          '2026-03-10': 1.5,
        },
        keepDays: 7,
        kept: ['2026-03-10'],
        full: true,
        overfull: false,
      },
      {
        what: 'today past twice the cap',
        days: { '2026-03-10': 2.5 },
        keepDays: 7,
        kept: ['2026-03-10'],
        full: true,
        overfull: true,
      },
      {
        what: 'a day after today, past the cap, from a clock that moved back',
        days: {
          '2026-03-10': 0.1,
          '2026-03-11': 1.5,
        },
        keepDays: 7,
        kept: ['2026-03-10'],
        full: false,
        overfull: false,
      },
    ]

    for (const given of cases) {
      const retained = keptDays({
        days: Object.entries(given.days).map(([
          day,
          mb,
        ]) => ({
          day,
          bytes: mb * MB,
        })),
        keepDays: given.keepDays,
        maxBytes: MB,
        today: '2026-03-10',
      })
      assert.deepEqual(
        {
          kept: [...retained.kept].toSorted(),
          full: retained.full,
          overfull: retained.overfull,
        },
        {
          kept: given.kept,
          full: given.full,
          overfull: given.overfull,
        },
        given.what,
      )
    }
  },
)
