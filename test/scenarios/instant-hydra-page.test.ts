import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listHydras } from '../../src/server/hydras.ts'
import { browserGroup } from './browser.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

test(
  'uncached Hydra selection renders its own shell before a held subscription and ignores an old held write',
  async () => {
    const a = await pnyx.scenario()
    const b = await pnyx.scenario()
    const c = await pnyx.scenario()
    await a.owner({
      args: [
        'task',
        'create',
        '--title',
        'Only in A',
      ],
    })
    await b.owner({
      args: [
        'task',
        'create',
        '--title',
        'Only in B',
      ],
    })
    await c.owner({
      args: [
        'task',
        'create',
        '--title',
        'Only in C',
      ],
    })
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${a.hydraId}/` })

    try {
      await page.shows({
        what: 'A connected',
        check: () => document.querySelector('[data-connected=true]'),
      })
      await page.shows({
        what: 'hold the A write and B subscription',
        arg: {
          a: a.hydraId,
          b: b.hydraId,
        },
        check: ({
          a,
          b,
        }) => {
          const original = WebSocket.prototype.send
          const control = window as unknown as {
            releaseA: () => void
            releaseB: () => void
            releaseAll: () => void
            socketCount: number
          }
          let installed = false
          const sockets = new Set<WebSocket>()
          const incoming: MessageEvent[] = []
          let holdingB = true

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            sockets.add(this)
            control.socketCount = sockets.size
            const message = typeof data === 'string' ? JSON.parse(data) : null

            if (!installed) {
              installed = true
              const receive = this.onmessage!

              this.onmessage = event => {
                const payload = JSON.parse(event.data)

                if (payload.scope === b && holdingB) {
                  incoming.push(event)
                } else {
                  receive.call(
                    this,
                    event,
                  )
                }
              }

              control.releaseB = () => {
                holdingB = false

                for (const event of incoming.splice(0)) {
                  receive.call(
                    this,
                    event,
                  )
                }
              }

              control.releaseAll = () => {
                WebSocket.prototype.send = original
                this.onmessage = receive
                control.releaseB()
                control.releaseA?.()
              }
            }

            if (message?.name === 'column' && message.args[0] === 'rename' && (!message.scope || message.scope === a)) {
              control.releaseA = () => {
                original.call(
                  this,
                  data,
                )
                control.releaseA = () => {}
              }
            } else {
              original.call(
                this,
                data,
              )
            }
          }

          return true
        },
      })
      await page.shows({
        what: 'a previously saved B draft',
        arg: { identity: listHydras().find(row => row.id === b.hydraId)!.identity },
        check: ({ identity }) => {
          sessionStorage.setItem(
            `pnyx:${identity}:restore`,
            JSON.stringify({ drafts: { '$hydra': 'Saved B draft' } }),
          )

          return true
        },
      })
      await page.click({ selector: '.column-queued .inline-title' })
      await page.press({ key: 'Enter' })
      await page.type({ text: 'A waiting' })
      await page.press({ key: 'Enter' })
      await page.click({
        selector: '.hydra-name',
        text: b.hydraId,
      })
      await page.shows({
        what: 'selected B shell before any B acknowledgement',
        arg: { b: b.hydraId },
        check: ({ b }) => {
          return location.pathname === `/hydra/${b}/`
        && document.querySelector('.hydra-name[aria-current=page]')?.textContent?.includes(b)
        && !document.querySelector('.kanban')?.textContent?.includes('Only in A')
        && (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value === 'Saved B draft'
        },
      })
      await page.click({
        selector: '.hydra-name',
        text: c.hydraId,
      })
      await page.shows({
        what: 'C while A and the first B subscription remain held',
        check: () =>
          document.querySelector('[data-connected=true]') && document.querySelector('.kanban')?.textContent?.includes('Only in C'),
      })
      await page.shows({
        what: 'Back to the superseded B selection',
        check: () => {
          history.back()

          return true
        },
      })
      await page.shows({
        what: 'B shell still excludes A and C',
        arg: { b: b.hydraId },
        check: ({ b }) =>
          document.querySelector('main')?.getAttribute('data-hydra') === b
        && !document.querySelector('.kanban')?.textContent?.includes('Only in C')
        && !document.querySelector('.kanban')?.textContent?.includes('Only in A'),
      })
      await page.shows({
        what: 'release B frames',
        check: () => {
          ;(window as unknown as { releaseB: () => void }).releaseB()

          return true
        },
      })
      await page.shows({
        what: 'B connected while A write remains held',
        check: () => document.querySelector('[data-connected=true]') && document.querySelector('.kanban')?.textContent?.includes('Only in B'),
      })
      await page.click({
        selector: '.hydra-name',
        text: c.hydraId,
      })
      await page.shows({
        what: 'cached C',
        check: () => document.querySelector('.kanban')?.textContent?.includes('Only in C'),
      })
      await page.shows({
        what: 'Back to cached B',
        check: () => {
          history.back()

          return true
        },
      })
      await page.shows({
        what: 'cached B before the old A write is released',
        check: () => document.querySelector('.kanban')?.textContent?.includes('Only in B'),
      })
      const count = await page.shows({
        what: 'one physical socket across all selections',
        check: () => ({ count: (window as unknown as { socketCount: number }).socketCount }),
      })
      assert.equal(
        count.count,
        1,
      )
      await page.shows({
        what: 'release A without changing the selected Hydra',
        check: () => {
          ;(window as unknown as { releaseA: () => void }).releaseA()

          return true
        },
      })
      await until({
        what: 'the original A write to confirm on A',
        check: () =>
          a.state().config?.columns.some(column => column.title === 'A waiting'),
      })
      assert.ok(!b.state().config?.columns.some(column => column.title === 'A waiting'))
      await page.shows({
        what: 'B remains selected after the old A acknowledgement',
        arg: { b: b.hydraId },
        check: ({ b }) =>
          document.querySelector('main')?.getAttribute('data-hydra') === b
        && document.querySelector('.kanban')?.textContent?.includes('Only in B'),
      })
    } finally {
      await page.shows({
        what: 'restore transport',
        check: () => {
          ;(window as unknown as { releaseAll?: () => void }).releaseAll?.()

          return true
        },
      })
      await page.close()
    }
  },
)

test(
  'creating selects a focused provisional Hydra and promotes its identity without reloading or losing the draft',
  async () => {
    const s = await pnyx.scenario()
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })

    try {
      await page.shows({
        what: 'the initial Hydra connected',
        check: () => document.querySelector('[data-connected=true]'),
      })
      await page.shows({
        what: 'hold the creation allocation',
        check: () => {
          const control = window as unknown as {
            sameDocument: boolean
            releaseCreate?: () => void
            restoreCreate?: () => void
          }
          control.sameDocument = true
          const send = WebSocket.prototype.send

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = typeof data === 'string' ? JSON.parse(data) : null

            if (message?.name === 'hydras' && message.args[0] === 'create') {
              control.releaseCreate = () => send.call(
                this,
                data,
              )

              control.restoreCreate = () => {
                WebSocket.prototype.send = send
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
      await page.click({ selector: "[aria-label='Create Hydra']" })
      await page.shows({
        what: 'provisional selection and focused draft before allocation receipt',
        check: () => {
          return document.querySelector('main[data-provisional=true]')
        && document.activeElement === document.querySelector('.hydra-chat textarea')
        && document.querySelector('.hydra-name[aria-current=page]')?.textContent?.includes('Untitled')
        },
      })
      await page.type({ text: 'Keep this draft through creation' })
      await page.shows({
        what: 'release the saved identity',
        check: () => {
          const control = window as unknown as {
            releaseCreate: () => void
            restoreCreate: () => void
          }
          control.restoreCreate()
          control.releaseCreate()

          return true
        },
      })
      const canonical = await page.shows({
        what: 'canonical selected Hydra with the same document and draft',
        check: () => {
          const id = document.querySelector('main')?.getAttribute('data-hydra')

          return id?.startsWith('hydra-') && location.pathname === `/hydra/${id}/`
        && document.querySelector('[data-connected=true]')
        && (window as unknown as { sameDocument: boolean }).sameDocument
        && (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value === 'Keep this draft through creation'
        && !document.querySelector('main[data-provisional=true]') && { id }
        },
      })
      assert.ok(canonical.id)
      await page.shows({
        what: 'Back',
        check: () => {
          history.back()

          return true
        },
      })
      await page.shows({
        what: 'the original Hydra',
        arg: { id: s.hydraId },
        check: ({ id }) => document.querySelector('main')?.getAttribute('data-hydra') === id,
      })
      await page.shows({
        what: 'Forward',
        check: () => {
          history.forward()

          return true
        },
      })
      await page.shows({
        what: 'the canonical draft after Back and Forward',
        arg: canonical,
        check: ({ id }) => document.querySelector('main')?.getAttribute('data-hydra') === id
      && (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value === 'Keep this draft through creation',
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
