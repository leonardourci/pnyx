import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

test(
  'a saved edit releases later writes when its receipt is lost',
  async () => {
    const s = await pnyx.scenario()
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.shows({
      what: 'the connected Hydra',
      check: () => document.querySelector('[data-connected=true]'),
    })
    await page.shows({
      what: 'drop rename receipts while allowing their durable events',
      check: () => {
        const send = WebSocket.prototype.send
        const control = window as unknown as { renamesSent: string[] }
        control.renamesSent = []

        // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes a single payload.
        WebSocket.prototype.send = function(data) {
          const message = JSON.parse(String(data))

          if (message.name === 'column' && message.args[0] === 'rename') {
            control.renamesSent.push(message.id)
            const receive = this.onmessage!

            this.onmessage = event => {
              const response = JSON.parse(String(event.data))

              if (response.type === 'receipt' && response.id === message.id) {
                return
              }

              receive.call(
                this,
                event,
              )
            }
          }

          send.call(
            this,
            data,
          )
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
          'Saved first',
        ],
        [
          'in_progress',
          'Saved second',
        ],
      ]) {
      await page.click({ selector: `.column-${column} .inline-title` })
      await page.press({ key: 'Enter' })
      await page.type({ text: title })
      await page.press({ key: 'Enter' })
    }

    await page.shows({
      what: 'both edit events confirmed without receipts or a reconnect',
      check: () => document.querySelector('.column-in_progress h2')?.textContent?.includes('Saved second')
        && !document.querySelector('[data-pending]'),
    })
    assert.equal(
      s.state().config?.columns.find(column => column.role === 'in_progress')?.title,
      'Saved second',
    )
    const sent = await page.shows({
      what: 'one send per rename',
      check: () => (window as unknown as { renamesSent: string[] }).renamesSent,
    })
    assert.equal(
      sent.length,
      2,
    )
    assert.equal(
      new Set(sent).size,
      2,
    )
    await page.close()
  },
)

test(
  'refused old-scope work preserves the destination draft and its own visible reason',
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
          releaseCreate: () => boolean
          widthsSent: number
          parentRefused: boolean
          socket: WebSocket
        }
        control.widthsSent = 0
        control.parentRefused = false

        // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes a single payload.
        WebSocket.prototype.send = function(data) {
          control.socket = this
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

            control.releaseCreate = () => {
              if (this.readyState !== WebSocket.OPEN) {
                return false
              }

              send.call(
                this,
                data,
              )

              return true
            }
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
      what: 'the provisional column title editor focused before its acknowledgement',
      check: () => document.activeElement instanceof HTMLInputElement
        && document.activeElement.value === 'New column'
        && document.activeElement.closest('[data-column^="custom:"]'),
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
      what: 'the destination connected while old work is held',
      check: () => document.querySelector('[data-connected=true]') && !document.querySelector('.loading-status'),
    })
    await page.click({ selector: '.hydra-chat textarea' })
    await page.type({ text: 'Keep the destination draft' })
    await page.shows({
      what: 'release the stale creation',
      check: () => (window as unknown as { releaseCreate?: () => boolean }).releaseCreate?.(),
    })
    await page.shows({
      what: 'destination connected after refused old work settles',
      check: () => document.querySelector('[data-connected=true]') && !document.querySelector('.loading-status')
        && (window as unknown as { parentRefused: boolean }).parentRefused
        && !document.querySelector('.error-banner')
        && (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value === 'Keep the destination draft',
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
    await page.click({
      selector: '.hydra-name',
      text: s.hydraId,
    })
    const reason = await page.shows({
      what: 'the original Hydra retains its refusal',
      check: () => document.querySelector('[data-connected=true]')
        && document.querySelector('.error-banner')?.textContent,
    })
    await page.shows({
      what: 'observe the next unrelated live update',
      arg: { scope: s.hydraId },
      check: ({ scope }) => {
        const control = window as unknown as {
          socket: WebSocket
          sawLatest: boolean
        }
        control.sawLatest = false
        control.socket.addEventListener(
          'message',
          event => {
            const message = JSON.parse(String(event.data))

            if (message.type === 'latest' && message.scope === scope) {
              control.sawLatest = true
            }
          },
        )

        return true
      },
    })
    await s.chat({ text: 'Refresh refusal feedback.' })
    await page.shows({
      what: 'live output leaves the refusal explanation visible',
      arg: { reason },
      check: ({ reason }) => (window as unknown as { sawLatest: boolean }).sawLatest
        && document.querySelector('.error-banner')?.textContent === reason,
    })
    await page.close()
  },
)
