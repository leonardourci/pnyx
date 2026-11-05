import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usageFor } from './usage.ts'

test(
  'neutral usage keeps recorded totals separate from context and estimates only complete text',
  () => {
    const reading = usageFor({
      agent: {
        provider: 'codex',
        sessionId: 'synthetic',
      },
      live: {
        used: 84_000,
        window: 200_000,
        cost: 0,
      },
      spend: {
        total: 120_000,
        worker: 100_000,
        hydra: 20_000,
        unavailable: 1,
        sharedHydra: true,
      },
      contextText: 'unrelated assembled text',
    })
    assert.deepEqual(
      reading.context,
      {
        used: 84_000,
        window: 200_000,
        left: 116_000,
        source: 'reported',
      },
    )
    assert.deepEqual(
      reading.recorded,
      {
        tokens: 120_000,
        cost: 0,
        worker: 100_000,
        hydra: 20_000,
        unavailable: 1,
        sharedHydra: true,
      },
    )
    assert.deepEqual(
      usageFor({ contextText: '你好🙂' }).context,
      {
        used: 3,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      usageFor({
        live: { used: NaN },
        contextText: '',
      }).context,
      {
        used: 0,
        source: 'estimated',
      },
    )
    assert.equal(
      usageFor({
        spend: {
          total: 99,
          unavailable: 0,
          sharedHydra: false,
        },
      }).context,
      undefined,
    )
    assert.equal(
      usageFor({}).unavailable,
      'Current context has not been reported',
    )
    const limits = usageFor({
      now: 1_800_000_000_000,
      live: {
        limits: [
          {
            label: 'session',
            used: 80,
            resetsAt: '2020-01-01T00:00:00Z',
          },
          {
            label: 'WEEK',
            used: 90,
            resetsAt: '2030-01-01T00:00:00Z',
          },
        ],
      },
      plan: {
        plan: 'pro',
        windows: [
          {
            label: 'session',
            used: 20,
          },
          {
            label: 'week',
            used: 50,
          },
        ],
      },
    })
    assert.deepEqual(
      limits.windows,
      [
        {
          label: 'session',
          used: 20,
        },
        {
          label: 'WEEK',
          used: 90,
          resetsAt: '2030-01-01T00:00:00Z',
        },
      ],
    )
    assert.equal(
      limits.who.plan,
      'pro',
    )
  },
)
