import assert from 'node:assert/strict'
import { test } from 'node:test'
import { afterSteadyLayout } from './scroll-task.ts'

test(
  'alignment waits until the clicked card stops moving while the card it replaced shrinks',
  async () => {
    Object.assign(
      globalThis,
      {
        requestAnimationFrame: setImmediate,
        cancelAnimationFrame: clearImmediate,
      },
    )

    try {
      const tops = [
        586,
        438,
        363,
        346,
        346,
      ]
      let reads = 0
      const element = {
        getBoundingClientRect: () => ({
          top: tops[Math.min(
            reads++,
            tops.length - 1,
          )],
        }),
      } as HTMLElement
      assert.equal(
        await afterSteadyLayout({
          element,
          signal: new AbortController().signal,
        }),
        true,
      )
      assert.equal(
        reads,
        tops.length,
      )

      const controller = new AbortController()
      controller.abort()
      assert.equal(
        await afterSteadyLayout({
          element,
          signal: controller.signal,
        }),
        false,
      )
    } finally {
      Reflect.deleteProperty(
        globalThis,
        'requestAnimationFrame',
      )
      Reflect.deleteProperty(
        globalThis,
        'cancelAnimationFrame',
      )
    }
  },
)
