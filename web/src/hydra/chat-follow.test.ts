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
    // Each scroll lands inside the window the one before it renewed.
    follow.scrolled({
      at: 600,
      top: 100,
      remaining: 900,
    })
    follow.scrolled({
      at: 1200,
      top: 400,
      remaining: 600,
    })
    follow.scrolled({
      at: 1800,
      top: 700,
      remaining: 300,
    })
    follow.scrolled({
      at: 2400,
      top: 990,
      remaining: 10,
    })
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
  'scrolls while the chat follows do not renew the owner window, so a later layout scroll keeps following',
  () => {
    const { follow } = tracked()
    follow.input({ at: 0 })
    // The glide to the bottom after the owner's input.
    follow.scrolled({
      at: OWNER_SCROLL_MS / 2,
      top: 500,
      remaining: 0,
    })
    // A top trim's anchoring scroll, after the owner's window ended.
    follow.scrolled({
      at: OWNER_SCROLL_MS + 200,
      top: 300,
      remaining: 200,
    })
    assert.equal(
      follow.following(),
      true,
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
