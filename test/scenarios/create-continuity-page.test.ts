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
      release(): boolean
      stop(): void
    }
  }
  const state: typeof control.continuity = control.continuity = {
    removed: 0,
    gaps: 0,
    frames: 0,
    release: () => false,
    stop: () => {},
  }
  const send = WebSocket.prototype.send

  // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
  WebSocket.prototype.send = function(data) {
    const message = JSON.parse(String(data))

    // The page can send after the click or resend after a reconnect, so release() sends
    // the latest held frame only on an open socket and says whether it did.
    if (message.name === name && message.args[0] === action) {
      state.release = () => {
        if (this.readyState !== WebSocket.OPEN) {
          return false
        }

        send.call(
          this,
          data,
        )

        return true
      }

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
    // The page can move focus back to the title, so focus the ask and write it in one step until it holds the text.
    await page.shows({
      what: 'the ask written',
      arg: { text: 'Keep the task visible while this longer owner ask is saved and confirmed in the background.' },
      check: ({ text }) => {
        const ask = document.querySelector<HTMLTextAreaElement>('[aria-label="Your ask"]')

        if (ask && ask.value !== text) {
          ask.focus()
          document.execCommand(
            'insertText',
            false,
            text,
          )
        }

        return ask?.value === text
      },
    })
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
      check: () => (window as unknown as { continuity: { release(): boolean } }).continuity
        .release(),
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

test(
  'project creation keeps its visible DOM node through confirmation',
  async () => {
    const s = await pnyx.scenario()
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.shows({
      what: 'connected Hydra',
      check: () => document.querySelector('[data-connected=true]'),
    })
    const folder = s.folder({ name: 'Continuous project' })
    await page.click({ selector: '[aria-label="Oracle"]' })
    await page.type({ text: 'Projects' })
    await page.shows({
      what: 'loaded project settings',
      check: () => document.querySelector('[aria-label="Projects"]')?.textContent?.includes('No projects attached.'),
    })
    await page.click({
      selector: '[aria-label="Projects"] .add-project-box button',
      text: 'Add a folder',
    })
    await page.click({ selector: '[aria-label="Projects"] [aria-label="Folder path"]' })
    await page.type({ text: folder })
    await page.shows({
      what: 'validated project folder',
      check: () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Projects"] .project-form button')].some(button => button.textContent === 'Add project' && !button.disabled),
    })
    const selector = '.project-row'
    const title = 'Continuous project'
    await page.shows({
      what: 'observe the creation before sending',
      check: observeCreation,
      arg: {
        selector,
        text: title,
        name: 'project',
        action: 'add',
        trigger: '[aria-label="Projects"] .project-form',
        event: 'submit',
        details: false,
      },
    })
    await page.click({
      selector: '[aria-label="Projects"] .project-form button',
      text: 'Add project',
    })
    const immediate = await page.shows({
      what: 'first visible creation frame',
      check: () => {
        const state = (window as unknown as { continuity: { firstFrame?: boolean } }).continuity

        return state.firstFrame === undefined ? false : { visible: state.firstFrame }
      },
    })
    assert.equal(
      immediate.visible,
      true,
    )
    await page.shows({
      what: 'release confirmation',
      check: () => (window as unknown as { continuity: { release(): boolean } }).continuity
        .release(),
    })
    await page.shows({
      what: 'creation confirmed',
      check: () => !document.querySelector('[data-pending]') && !document.querySelector('.project-row [role=status]'),
    })
    const result = await page.shows({
      what: 'the same visible element after confirmation',
      arg: {
        selector,
        title,
      },
      check: ({
        selector,
        title,
      }) => {
        const state = (window as unknown as {
          continuity: {
            removed: number
            gaps: number
            node?: HTMLElement
            stop(): void
          }
        }).continuity
        const elements = [...document.querySelectorAll(selector)]
        const node = elements.find(element => element.textContent?.includes(title)
            || element.querySelector<HTMLInputElement>('input')?.value === title)
        state.stop()

        return {
          same: node === state.node,
          removed: state.removed,
          gaps: state.gaps,
        }
      },
    })
    assert.deepEqual(
      result,
      {
        same: true,
        removed: 0,
        gaps: 0,
      },
    )

    assert.ok(s.state().projects?.some(project => project.path === folder && !project.detached))

    await page.close()
  },
)
