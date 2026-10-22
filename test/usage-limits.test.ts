import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeLimit } from '../src/server/claude.ts'
import { codexLimits } from '../src/server/codex.ts'

test(
  'the agents’ own rate limit reports become labelled plan windows',
  () => {
    assert.deepEqual(
      claudeLimit({
        info: {
          status: 'allowed',
          rateLimitType: 'seven_day_opus',
          utilization: 0.21,
          resetsAt: 1_800_000_000,
        },
      }),
      {
        label: 'Opus week',
        used: 21,
        resetsAt: new Date(1_800_000_000_000).toISOString(),
      },
    )
    assert.equal(
      claudeLimit({
        info: {
          status: 'allowed',
          rateLimitType: 'overage',
          utilization: 0.5,
        },
      }),
      undefined,
    )
    assert.deepEqual(
      codexLimits({
        rateLimits: {
          planType: 'pro',
          primary: {
            usedPercent: 12.4,
            windowDurationMins: 300,
            resetsAt: 1_800_000_000,
          },
          secondary: {
            usedPercent: 30,
            windowDurationMins: 10_080,
          },
        },
      }),
      {
        type: 'usage',
        plan: 'pro',
        limits: [
          {
            label: 'session',
            used: 12,
            resetsAt: new Date(1_800_000_000_000).toISOString(),
          },
          {
            label: 'week',
            used: 30,
          },
        ],
      },
    )
  },
)
