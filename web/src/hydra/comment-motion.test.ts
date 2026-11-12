import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MESSAGE_SCROLL, scrollMessage } from './comment-motion.ts'

const VIEWPORT_PX = 500

test(
  'a passage already in view raises no message scroll, so a following chat keeps following',
  t => {
    const previous = globalThis.matchMedia
    globalThis.matchMedia = (() => ({ matches: true })) as unknown as typeof matchMedia
    t.after(() => {
      globalThis.matchMedia = previous
    })
    const scroller = Object.assign(
      new EventTarget(),
      {
        scrollTop: 1000,
        scrollHeight: 3000,
        clientHeight: VIEWPORT_PX,
        getBoundingClientRect: () => ({
          top: 0,
          bottom: VIEWPORT_PX,
          height: VIEWPORT_PX,
        }),
        scrollTo({ top }: { top: number }) {
          scroller.scrollTop = top
        },
      },
    )
    const raised: number[] = []
    scroller.addEventListener(
      MESSAGE_SCROLL,
      () => raised.push(scroller.scrollTop),
    )
    const host = { closest: () => scroller } as unknown as HTMLElement

    const reveal = ({ top }: { top: number }) => scrollMessage({
      host,
      bounds: {
        top,
        bottom: top + 20,
        height: 20,
      } as DOMRect,
    })

    reveal({ top: 200 })
    assert.deepEqual(
      raised,
      [],
    )
    reveal({ top: 2 * VIEWPORT_PX })
    assert.deepEqual(
      raised,
      [1000],
    )
    assert.ok(scroller.scrollTop > 1000)
  },
)
