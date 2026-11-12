import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { SETTLE_MS, settle } from './child-fixture.ts'

const TEST_TIMEOUT_MS = 15_000
const FALLBACK_MS = 10_000
const MAX_WAIT_MS = 9000
const TICK_MS = 1000

test(
  'settle expires with a frozen Date and preserves explicit timer ticks',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    mock.timers.enable({
      apis: ['Date'],
      now: 0,
    })
    t.after(() => mock.timers.reset())
    const started = performance.now()
    const fallback = setTimeout(
      () => mock.timers.tick(FALLBACK_MS),
      FALLBACK_MS,
    )

    try {
      await assert.rejects(
        settle({
          what: 'frozen Date deadline',
          check: () => false,
        }),
        /frozen Date deadline/,
      )
    } finally {
      clearTimeout(fallback)
    }

    assert.ok(
      performance.now() - started < MAX_WAIT_MS,
      'settle expires independently of frozen Date',
    )
    await assert.rejects(
      settle({
        what: 'ticked deadline',
        check: () => false,
        tick: TICK_MS,
      }),
      /ticked deadline/,
    )
    assert.equal(
      Date.now(),
      SETTLE_MS,
      'each pass moved the mocked clock until the settle bound',
    )
  },
)
