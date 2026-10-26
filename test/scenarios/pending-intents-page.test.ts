import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

test(
  'held edits show pending immediately; refusing the first preserves a pushed change and confirms the second',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Review the pending edits',
        '--key',
        'review',
      ],
    })
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.shows({
      what: 'the connected Hydra',
      check: () => document.querySelector('[data-connected=true]'),
    })

    if (process.env.PNYX_CAPTURE_PENDING_UI) {
      await page.capture({ path: `${process.env.PNYX_CAPTURE_PENDING_UI}/initial.png` })
    }

    const queued = s.state().config!.columns.find(column => column.role === 'queued')!.id
    await page.shows({
      what: 'an outgoing rename held before daemon acknowledgement',
      arg: { queued },
      check: ({ queued }) => {
        const send = WebSocket.prototype.send
        const control = window as unknown as { releaseRename: () => void }

        // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes a single payload.
        WebSocket.prototype.send = function(data) {
          const message = typeof data === 'string' ? JSON.parse(data) : null

          if (message?.name === 'column' && message.args[0] === 'rename' && message.args[1] === queued) {
            control.releaseRename = () => {
              WebSocket.prototype.send = send
              send.call(
                this,
                data,
              )
            }
          } else {
            send.call(
              this,
              data,
            )
          }
        }

        return true
      },
    })

    for (const [
      column,
      title,
    ] of [
        [
          'queued',
          'Pending first',
        ],
        [
          'in_progress',
          'Pending second',
        ],
      ]) {
      await page.click({ selector: `.column-${column} .inline-title` })
      await page.press({ key: 'Enter' })
      await page.type({ text: title })
      await page.press({ key: 'Enter' })
    }

    await page.shows({
      what: 'both previews and shared pending feedback before any receipt',
      check: () => document.querySelector('.column-queued h2')?.textContent?.includes('Pending first')
      && document.querySelector('.column-in_progress h2')?.textContent?.includes('Pending second')
      && document.querySelector('[data-pending=saving]'),
    })

    if (process.env.PNYX_CAPTURE_PENDING_UI) {
      await page.capture({ path: `${process.env.PNYX_CAPTURE_PENDING_UI}/pending.png` })
    }

    assert.equal(
      s.state().config?.columns.find(column => column.role === 'queued')?.title,
      'Queued',
    )
    await s.owner({
      args: [
        'column',
        'describe',
        'queued',
        '--description',
        'Pushed while saving',
      ],
    })
    await page.shows({
      what: 'the unrelated pushed description',
      check: () => document.querySelector('.column-queued h2')?.getAttribute('title') === 'Pushed while saving',
    })
    await page.shows({
      what: 'the delayed command released',
      check: () => {
        ;(window as unknown as { releaseRename: () => void }).releaseRename()

        return true
      },
    })
    await page.shows({
      what: 'the refused preview reverted, the independent edit saved and the daemon reason visible',
      check: () => document.querySelector('.column-queued .inline-title')?.textContent?.includes('Queued')
      && document.querySelector('.column-queued h2')?.getAttribute('title') === 'Pushed while saving'
      && document.querySelector('.column-in_progress .inline-title')?.textContent?.includes('Pending second')
      && document.querySelector('.error-banner')?.textContent
      && !document.querySelector('[data-pending]'),
    })
    assert.equal(
      s.state().config?.columns.find(column => column.role === 'in_progress')?.title,
      'Pending second',
    )

    if (process.env.PNYX_CAPTURE_PENDING_UI) {
      await page.capture({ path: `${process.env.PNYX_CAPTURE_PENDING_UI}/settled.png` })
    }

    await page.close()
  },
)

test(
  'navigation discards refused dependent writes before draining the old Hydra transport',
  async () => {
    const s = await pnyx.scenario()
    const destination = await pnyx.scenario()
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.shows({
      what: 'the connected Hydra',
      check: () => document.querySelector('[data-connected=true]'),
    })
    await page.shows({
      what: 'hold creation and record actual dependent sends',
      check: () => {
        const send = WebSocket.prototype.send
        const control = window as unknown as {
          releaseCreate: () => void
          widthsSent: number
          parentRefused: boolean
        }
        control.widthsSent = 0
        control.parentRefused = false

        // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes a single payload.
        WebSocket.prototype.send = function(data) {
          const message = typeof data === 'string' ? JSON.parse(data) : null

          if (message?.name === 'column' && message.args[0] === 'create') {
            this.addEventListener(
              'message',
              event => {
                const receipt = JSON.parse(event.data)

                if (receipt.id === message.id && receipt.type === 'error') {
                  control.parentRefused = true
                }
              },
            )
            control.releaseCreate = () => send.call(
              this,
              data,
            )
          } else {
            if (message?.name === 'view' && message.args.some((value: string) => value.includes('columnWidths'))) {
              control.widthsSent++
            }

            send.call(
              this,
              data,
            )
          }
        }

        return true
      },
    })
    await page.click({ selector: '.add-column button' })
    await page.shows({
      what: 'the provisional column',
      check: () => [...document.querySelectorAll('.column .inline-title')].some(el => el.textContent === 'New column'),
    })
    await page.click({ selector: "[aria-label='Resize New column column']" })
    await page.press({ key: 'ArrowRight' })
    await s.owner({
      args: [
        'column',
        'describe',
        'queued',
        '--description',
        'Concurrent update',
      ],
    })
    await page.shows({
      what: 'the concurrent configuration event',
      check: () => document.querySelector('.column-queued h2')?.getAttribute('title') === 'Concurrent update',
    })
    await page.click({
      selector: '.hydra-name',
      text: destination.hydraId,
    })
    await page.shows({
      what: 'navigation selection before old writes settle',
      arg: { hydra: destination.hydraId },
      check: ({ hydra }) => location.pathname === `/hydra/${hydra}/`,
    })
    await page.shows({
      what: 'release the stale creation',
      check: () => {
        ;(window as unknown as { releaseCreate: () => void }).releaseCreate()

        return true
      },
    })
    await page.shows({
      what: 'destination connected after refused old work settles',
      check: () => document.querySelector('[data-connected=true]') && !document.querySelector('.loading-status')
        && (window as unknown as { parentRefused: boolean }).parentRefused,
    })
    const sent = await page.shows({
      what: 'the transmitted width command count',
      check: () => ({ count: (window as unknown as { widthsSent: number }).widthsSent }),
    })
    assert.equal(
      sent.count,
      0,
      'a refused dependent must never reach the daemon',
    )
    await page.close()
  },
)
