import assert from 'node:assert/strict'
import { test } from 'node:test'
import { virtualWindow } from './virtual-window.ts'

const keys = Array.from(
  { length: 1000 },
  (
    _,
    index,
  ) => `row-${index}`,
)

const windowAt = ({
  top,
  bottom,
  sizes = new Map<string, number>(),
  minimum = 40,
}: {
  top: number
  bottom: number
  sizes?: Map<string, number>
  minimum?: number
}) => virtualWindow({
  keys,
  sizes,
  estimate: 100,
  top,
  bottom,
  overscan: 200,
  minimum,
})

test(
  'a list renders only the rows near the viewport and stands in for the rest with spacers',
  () => {
    const shown = windowAt({
      top: 50_000,
      bottom: 50_800,
    })

    assert.equal(
      shown.start,
      497,
    )
    assert.equal(
      shown.end,
      510,
    )
    assert.equal(
      shown.before,
      49_700,
    )
    assert.equal(
      shown.after,
      (1000 - shown.end) * 100,
    )
  },
)

test(
  'measured heights replace the estimate, and the spacers and rows always add up to the whole list',
  () => {
    const sizes = new Map(keys.slice(
      0,
      100,
    ).map(key => [
      key,
      30,
    ]))
    const shown = windowAt({
      top: 1500,
      bottom: 2300,
      sizes,
    })
    const rendered = keys.slice(
      shown.start,
      shown.end,
    ).reduce(
      (
        sum,
        key,
      ) => sum + (sizes.get(key) ?? 100),
      0,
    )

    assert.equal(
      shown.before + rendered + shown.after,
      100 * 30 + 900 * 100,
    )
    assert.ok(shown.start > 40)
  },
)

test(
  'a short list renders whole, and a list scrolled past its end keeps its last row',
  () => {
    assert.deepEqual(
      windowAt({
        top: 0,
        bottom: 500,
        minimum: 1000,
      }),
      {
        start: 0,
        end: 1000,
        before: 0,
        after: 0,
      },
    )

    const past = windowAt({
      top: 900_000,
      bottom: 901_000,
    })

    assert.equal(
      past.end,
      1000,
    )
    assert.equal(
      past.start,
      999,
    )
    assert.equal(
      past.after,
      0,
    )
  },
)
