import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

const observeCreation = ({
  selector,
  text,
  name,
  action,
  trigger,
  event,
  details,
}: {
  selector: string
  text: string
  name: string
  action: string
  trigger: string
  event: string
  details: boolean
}) => {
  const control = window as unknown as {
    continuity: {
      firstFrame?: boolean
      removed: number
      gaps: number
      frames: number
      node?: HTMLElement
      release(): void
      stop(): void
    }
  }
  const state: typeof control.continuity = control.continuity = {
    removed: 0,
    gaps: 0,
    frames: 0,
    release: () => {},
    stop: () => {},
  }
  const send = WebSocket.prototype.send

  // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
  WebSocket.prototype.send = function(data) {
    const message = JSON.parse(String(data))

    if (message.name === name && message.args[0] === action) {
      state.release = () => send.call(
        this,
        data,
      )

      return
    }

    send.call(
      this,
      data,
    )
  }

  const find = () => {
    const elements = [...document.querySelectorAll<HTMLElement>(selector)]

    return elements.find(element => element.textContent?.includes(text)
      || element.querySelector<HTMLInputElement>('input')?.value === text)
  }

  const visible = ({ card }: { card: HTMLElement }) => {
    const box = card.getBoundingClientRect()
    const heading = card.querySelector('.task-updates-head')?.getBoundingClientRect()
    const style = getComputedStyle(card)

    return card.isConnected && Number(style.opacity) > 0 && style.visibility === 'visible'
        && style.display !== 'none' && box.height > 0 && box.bottom > 0 && box.top < innerHeight
        && (!details || (!!heading && heading.bottom <= box.bottom && heading.height > 0))
  }

  const observer = new MutationObserver(records => {
    if (!state.node) {
      state.node = find()
    }

    for (const record of records) {
      for (const node of record.removedNodes) {
        if (state.node && (node === state.node || node.contains(state.node))) {
          state.removed++
        }
      }
    }
  })
  observer.observe(
    document.body,
    {
      subtree: true,
      childList: true,
    },
  )
  let frame = 0
  const deadline = performance.now() + 30_000

  const sample = () => {
    state.frames++

    if (state.node) {
      if (!visible({ card: state.node })) {
        state.gaps++
      }
    }

    if (performance.now() < deadline) {
      frame = requestAnimationFrame(sample)
    }
  }

  frame = requestAnimationFrame(sample)
  const form = document.querySelector(trigger)!
  form.addEventListener(
    event,
    () => requestAnimationFrame(() => {
      const card = find(); state.firstFrame = !!card && visible({ card })
    }),
    { once: true },
  )

  state.stop = () => {
    observer.disconnect(); cancelAnimationFrame(frame); WebSocket.prototype.send = send
  }

  return true
}

test(
  'a new task appears on the first frame and keeps its DOM node through confirmation',
  async () => {
    const s = await pnyx.scenario()

    for (const key of Array.from(
      { length: 12 },
      (
        _,
        index,
      ) => String(index),
    )) {
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          `Existing ${key}`,
        ],
      })
    }

    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.shows({
      what: 'connected populated Hydra',
      check: () => document.querySelector('[data-connected=true]') && document.querySelectorAll('.card').length === 12,
    })
    await page.click({ selector: '[aria-label="New task in Queued"]' })
    await page.type({ text: 'Stay here after saving' })
    await page.click({ selector: '[aria-label="Your ask"]' })
    await page.type({ text: 'Keep the task visible while this longer owner ask is saved and confirmed in the background.' })
    await page.shows({
      what: 'watch the creation lifetime before submitting',
      check: observeCreation,
      arg: {
        selector: '.card',
        text: 'Stay here after saving',
        name: 'task',
        action: 'create',
        trigger: '.task-create',
        event: 'submit',
        details: true,
      },
    })
    await page.click({
      selector: '.task-create button',
      text: 'Save task',
    })
    const immediate = await page.shows({
      what: 'the first post-submit frame',
      check: () => {
        const state = (window as unknown as { continuity: { firstFrame?: boolean } }).continuity

        return state.firstFrame === undefined ? false : { visible: state.firstFrame }
      },
    })

    if (process.env.PNYX_CAPTURE_CONTINUITY) {
      await page.capture({ path: `${process.env.PNYX_CAPTURE_CONTINUITY}/first-frame.png` })
    }

    assert.equal(
      immediate.visible,
      true,
    )
    await page.shows({
      what: 'the provisional card before confirmation',
      check: () => document.querySelector('[data-task^="task:"]'),
    })
    await page.shows({
      what: 'release creation',
      check: () => {
        ;(window as unknown as { continuity: { release(): void } }).continuity.release()

        return true
      },
    })
    await page.shows({
      what: 'canonical creation and placement confirmed',
      check: () => !document.querySelector('[data-pending]') && !document.querySelector('[data-task^="task:"]'),
    })
    await page.shows({
      what: 'confirmed updates displayed in place',
      check: () => document.querySelector('.task-updates')?.textContent?.includes('Created') && !document.querySelector('.task-updates [role=status]'),
    })

    if (process.env.PNYX_CAPTURE_CONTINUITY) {
      await page.capture({ path: `${process.env.PNYX_CAPTURE_CONTINUITY}/confirmed.png` })
    }

    const result = await page.shows({
      what: 'the unchanged connected card element',
      check: () => {
        const state = (window as unknown as {
          continuity: {
            removed: number
            gaps: number
            frames: number
            node?: HTMLElement
            stop(): void
          }
        }).continuity
        const node = [...document.querySelectorAll('.card')].find(card => card.textContent?.includes('Stay here after saving'))
        state.stop()

        return {
          same: node === state.node,
          removed: state.removed,
          gaps: state.gaps,
          frames: state.frames,
        }
      },
    })
    assert.ok(result.frames > 0)
    assert.deepEqual(
      {
        same: result.same,
        removed: result.removed,
        gaps: result.gaps,
      },
      {
        same: true,
        removed: 0,
        gaps: 0,
      },
    )
    await page.close()
  },
)
