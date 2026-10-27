import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listHydras } from '../../src/server/hydras.ts'
import { loadHydra } from '../../src/store/hydra-store.ts'
import { browserGroup } from './browser.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

test(
  'a send started after identity promotion recovers its canonical attempt on reload',
  async () => {
    const s = await pnyx.scenario()
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })

    try {
      await page.shows({
        what: 'connected before promotion',
        check: () => document.querySelector('[data-connected=true]'),
      })
      await page.click({ selector: "[aria-label='Create Hydra']" })
      const canonical = await page.shows({
        what: 'canonical identity connected',
        check: () => {
          const id = document.querySelector('main')?.getAttribute('data-hydra')

          return id?.startsWith('hydra-') && document.querySelector('[data-connected=true]') && { id }
        },
      })
      await page.shows({
        what: 'drop the first outgoing chat before it is saved',
        check: () => {
          const send = WebSocket.prototype.send

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = JSON.parse(String(data))

            if (message.name === 'hydra' && message.args[0] === 'send') {
              Object.assign(
                window,
                { promotedAttempt: message.args[message.args.indexOf('--event-id') + 1] },
              )

              return
            }

            send.call(
              this,
              data,
            )
          }

          return true
        },
      })
      await page.click({ selector: '.hydra-chat textarea' })
      await page.type({ text: 'Keep this promoted send attempt' })
      await page.press({ key: 'Enter' })
      const attempt = await page.shows({
        what: 'the original promoted attempt identity',
        check: () => (window as unknown as { promotedAttempt: string }).promotedAttempt,
      })
      await page.reload()
      await until({
        what: 'the promoted send recovered from canonical storage',
        check: () => loadHydra({ hydraId: canonical.id }).state.hydraMessages
          ?.some(message => message.id === attempt),
      })
      const messages = loadHydra({ hydraId: canonical.id }).state.hydraMessages!
      assert.equal(
        messages.filter(message => message.id === attempt).length,
        1,
      )
      assert.equal(
        messages.find(message => message.id === attempt)?.text,
        'Keep this promoted send attempt',
      )
      await page.shows({
        what: 'the recovered send confirmed without a false failure',
        check: () => document.querySelector('.hydra-chat form')?.getAttribute('aria-busy') === 'false'
        && !document.querySelector('.save-checking, .send-error'),
      })
    } finally {
      await page.close()
    }
  },
)

test(
  'a saved creation with a lost receipt recovers after reload without allocating another Hydra',
  async () => {
    const s = await pnyx.scenario()
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })

    try {
      await page.shows({
        what: 'connected before creation recovery',
        check: () => document.querySelector('[data-connected=true]'),
      })
      await page.shows({
        what: 'suppress allocation acknowledgements',
        check: () => {
          const send = WebSocket.prototype.send
          const control = window as unknown as { creationAttempt: string }

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = typeof data === 'string' ? JSON.parse(data) : null

            if (message?.name === 'hydras' && message.args[0] === 'create') {
              control.creationAttempt = message.args[2]
              const receive = this.onmessage!

              this.onmessage = event => {
                const payload = JSON.parse(event.data)
                const allocation = payload.creation?.attempt === control.creationAttempt
                const listed = payload.hydras?.some((row: { creationAttempt?: string }) =>
                  row.creationAttempt === control.creationAttempt)

                if (!allocation && !listed) {
                  receive.call(
                    this,
                    event,
                  )
                }
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
      await page.click({ selector: "[aria-label='Create Hydra']" })
      const attempt = await page.shows({
        what: 'a pending saved attempt',
        check: () => document.querySelector('main[data-provisional=true]')
        && (window as unknown as { creationAttempt: string }).creationAttempt,
      })
      await page.type({ text: 'Recover my creation draft' })
      const canonical = await until({
        what: 'the allocation to be durable without delivering its receipt',
        check: () => listHydras().find(row => row.creationAttempt === attempt),
      })
      const count = listHydras().length
      await page.reload()
      await page.shows({
        what: 'the same canonical Hydra and recovered draft after reload',
        arg: { id: canonical.id },
        check: ({ id }) => document.querySelector('main')?.getAttribute('data-hydra') === id
        && document.querySelector('[data-connected=true]')
        && (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value === 'Recover my creation draft',
      })
      assert.equal(
        listHydras().length,
        count,
      )
      assert.equal(
        listHydras().filter(row => row.creationAttempt === attempt).length,
        1,
      )
    } finally {
      await page.close()
    }
  },
)
