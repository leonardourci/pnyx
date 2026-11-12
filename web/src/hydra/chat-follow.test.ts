import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatFollow, OWNER_SCROLL_MS, watchHistoryFocus } from './chat-follow.ts'

const tracked = () => {
  const reports: boolean[] = []
  const follow = createChatFollow({ changed: ({ away }) => reports.push(away) })

  return {
    follow,
    reports,
  }
}

test(
  'expanding a row stops following and reports the chat away, so the trim and the receive agree',
  () => {
    const {
      follow,
      reports,
    } = tracked()
    follow.expand({ at: 0 })
    assert.equal(
      follow.following(),
      false,
    )
    assert.deepEqual(
      reports,
      [true],
    )
  },
)

test(
  'a scroll that keeps going from the owner input resumes following at the bottom after the input window',
  () => {
    const {
      follow,
      reports,
    } = tracked()
    follow.stop()
    follow.input({ at: 0 })
    const step = OWNER_SCROLL_MS * 0.6

    for (const [
      index,
      remaining,
    ] of [
        900,
        600,
        300,
        10,
      ].entries()) {
      follow.scrolled({
        at: step * (index + 1),
        top: 1000 - remaining,
        remaining,
      })
    }

    assert.equal(
      follow.following(),
      true,
    )
    assert.equal(
      reports.at(-1),
      false,
    )
  },
)

test(
  'a layout scroll near the bottom without owner input does not resume following',
  () => {
    const { follow } = tracked()
    follow.input({ at: 0 })
    follow.stop()
    follow.scrolled({
      at: 10,
      top: 990,
      remaining: 0,
    })
    assert.equal(
      follow.following(),
      false,
    )
  },
)

test(
  'removing a focused control inside the messages ends the reading it held',
  t => {
    const previous = globalThis.document
    const control = { tagName: 'BUTTON' }
    const fake = Object.assign(
      new EventTarget(),
      {
        activeElement: control as unknown,
        getSelection: () => ({
          anchorNode: null,
          focusNode: null,
          isCollapsed: true,
        }),
      },
    )
    globalThis.document = fake as unknown as Document
    t.after(() => {
      globalThis.document = previous
    })
    const reports: boolean[] = []
    const stop = watchHistoryFocus({
      // eslint-disable-next-line pnyx/object-params -- Node.contains contract.
      host: () => ({ contains: (node: unknown) => node === control }) as unknown as Element,
      changed: ({ selected }) => reports.push(selected),
    })
    fake.dispatchEvent(new Event('focusin'))
    fake.activeElement = { tagName: 'BODY' }
    fake.dispatchEvent(new Event('focusout'))
    stop()
    assert.deepEqual(
      reports,
      [
        true,
        false,
      ],
    )
  },
)
