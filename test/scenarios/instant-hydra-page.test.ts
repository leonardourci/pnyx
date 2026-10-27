import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { commands } from '../../src/cli/commands.ts'
import { listHydras } from '../../src/server/hydras.ts'
import { loadHydra } from '../../src/app/store.ts'
import { hydraDir } from '../../src/app/home-migration.ts'
import { browserGroup } from '../../src/test-harness/browser.ts'
import { scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

test(
  'another installation at the same origin cannot inherit pending creations or snapshots',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Private to installation A',
      ],
    })
    const home = process.env.PNYX_HOME
    assert.ok(home)
    const alternate = join(
      home,
      'alternate-installation',
    )
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })

    try {
      await page.shows({
        what: 'installation A connected',
        check: () => document.querySelector('[data-connected=true]'),
      })
      await page.shows({
        what: 'leave a creation unallocated in installation A',
        check: () => {
          const send = WebSocket.prototype.send

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = JSON.parse(String(data))

            if (message.name === 'hydras' && message.args[0] === 'create') {
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
      await page.click({ selector: "[aria-label='Create Hydra']" })
      await page.shows({
        what: 'A provisional draft',
        check: () => document.querySelector('main[data-provisional=true]'),
      })
      await page.type({ text: 'Private creation draft A' })
      await pnyx.restart({
        whileStopped: () => {
          process.env.PNYX_HOME = alternate
          fs.mkdirSync(
            alternate,
            { recursive: true },
          )
          fs.writeFileSync(
            join(
              alternate,
              'settings.json',
            ),
            JSON.stringify({ 'search.semantic': 'off' }),
          )
          commands.hydra([
            'create',
            s.hydraId,
            '--name',
            'Second installation',
          ])
        },
      })
      const count = listHydras().length
      await page.reload()
      await page.shows({
        what: 'only installation B state and draft are shown',
        check: () => document.querySelector('[data-connected=true]')
        && document.querySelector('.hydra-name[aria-current=page]')?.textContent?.includes('Second installation')
        && !document.querySelector('.kanban')?.textContent?.includes('Private to installation A')
        && (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value !== 'Private creation draft A',
      })
      await page.click({ selector: '.column-queued .inline-title' })
      await page.press({ key: 'Enter' })
      await page.type({ text: 'B verified' })
      await page.press({ key: 'Enter' })
      await until({
        what: 'the installation B command after recovery queues have drained',
        check: () => loadHydra({ hydraId: s.hydraId }).state.config?.columns.some(column => column.title === 'B verified'),
      })
      assert.equal(
        listHydras().length,
        count,
      )
      assert.ok(listHydras().every(row => row.creationAttempt === undefined))
    } finally {
      await page.close()
      await pnyx.restart({
        whileStopped: () => {
          process.env.PNYX_HOME = home
        },
      })
    }
  },
)

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
            releaseStaleB(): void
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
                const latest = incoming.map(event => JSON.parse(event.data))
                  .filter(message => message.type === 'hello')
                  .at(-1)?.subscription
                const stale: MessageEvent[] = []

                for (const event of incoming.splice(0)) {
                  if (JSON.parse(event.data).subscription !== latest) {
                    stale.push(event)

                    continue
                  }

                  receive.call(
                    this,
                    event,
                  )
                }

                control.releaseStaleB = () => stale.forEach(event => receive.call(
                  this,
                  event,
                ))
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
      await b.owner({
        args: [
          'column',
          'rename',
          'queued',
          '--title',
          'Newer B column',
        ],
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
        check: () => document.querySelector('[data-connected=true]')
          && document.querySelector('.kanban')?.textContent?.includes('Only in B')
          && document.querySelector('.column-queued h2')?.textContent?.includes('Newer B column'),
      })
      await page.shows({
        what: 'deliver the superseded B snapshot after its newer subscription',
        check: () => {
          (window as unknown as { releaseStaleB(): void }).releaseStaleB()

          return true
        },
      })
      await page.shows({
        what: 'stale B frames cannot replace newer state or connection status',
        check: () => document.querySelector('[data-connected=true]')
          && document.querySelector('.column-queued h2')?.textContent?.includes('Newer B column'),
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

for (const recovery of [
  'foreground',
  'background',
  'reconnect',
  'mount-failure',
]) {
  test(
    `creating preserves the provisional draft through ${recovery} promotion`,
    async () => {
      const s = await pnyx.scenario()
      const write = fs.writeFileSync

      if (recovery === 'mount-failure') {
        const taken = new Set(listHydras().map(hydra => hydra.id))
        let next = taken.size + 1

        while (taken.has(`hydra-${next}`)) {
          next++
        }

        const broken = hydraDir({ hydraId: `hydra-${next}` })
        // eslint-disable-next-line pnyx/object-params -- writeFileSync owns its overloaded arguments.
        fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
          if (String(args[0]).startsWith(join(
            broken,
            'server.json.tmp-',
          ))) {
            throw new Error('Synthetic mount failure')
          }

          return write(...args)
        }) as typeof fs.writeFileSync
        syncBuiltinESMExports()
      }

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
              disconnectCreate?: () => void
              creationAttempts: string[]
              unknownSeen: boolean
            }
            control.sameDocument = true
            control.creationAttempts = []
            control.unknownSeen = false
            new MutationObserver(() => {
              if (document.querySelector('[data-pending=unknown]')) {
                control.unknownSeen = true
              }
            }).observe(
              document.body,
              {
                subtree: true,
                childList: true,
                attributes: true,
              },
            )
            const send = WebSocket.prototype.send
            let holding = true

            // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
            WebSocket.prototype.send = function(data) {
              const message = typeof data === 'string' ? JSON.parse(data) : null

              if (message?.name === 'hydras' && message.args[0] === 'create') {
                control.creationAttempts.push(message.args[2])
                control.disconnectCreate = () => this.close()

                if (!holding) {
                  send.call(
                    this,
                    data,
                  )

                  return
                }

                control.releaseCreate = () => send.call(
                  this,
                  data,
                )

                control.restoreCreate = () => {
                  holding = false
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

        if (recovery === 'background') {
          await page.click({
            selector: '.hydra-name',
            text: s.hydraId,
          })
          await page.shows({
            what: 'the original Hydra while allocation remains held',
            arg: { id: s.hydraId },
            check: ({ id }) => document.querySelector('main')?.getAttribute('data-hydra') === id,
          })
        }

        await page.shows({
          what: 'release the saved identity',
          arg: { recovery },
          check: ({ recovery }) => {
            const control = window as unknown as {
              releaseCreate: () => void
              restoreCreate: () => void
              disconnectCreate: () => void
            }
            control.restoreCreate()

            if (recovery === 'reconnect') {
              control.disconnectCreate()
            } else {
              control.releaseCreate()
            }

            return true
          },
        })

        if (recovery === 'background') {
          const attempt = await page.shows({
            what: 'the held creation attempt',
            check: () => (window as unknown as { creationAttempts: string[] }).creationAttempts[0],
          })
          const saved = await until({
            what: 'background allocation',
            check: () => listHydras().find(row => row.creationAttempt === attempt),
          })
          await page.click({
            selector: `.hydra-branch:has([aria-controls="projects-${saved.id}"]) .hydra-name`,
          })
        }

        if (recovery === 'mount-failure') {
          const failed = await page.shows({
            what: 'a saved canonical Hydra with a recoverable mount failure and its draft',
            check: () => {
              const id = document.querySelector('main')?.getAttribute('data-hydra')

              return id?.startsWith('hydra-')
              && document.querySelector('.error-banner')?.textContent?.includes('Synthetic mount failure')
              && (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value === 'Keep this draft through creation'
              && { id }
            },
          })
          const count = listHydras().length
          assert.ok(loadHydra({ hydraId: failed.id }).state.config)
          fs.writeFileSync = write
          syncBuiltinESMExports()
          await page.click({
            selector: '.error-banner button',
            text: 'Retry connection',
          })
          await page.shows({
            what: 'the saved Hydra connects on retry without another allocation',
            arg: failed,
            check: ({ id }) => document.querySelector('main')?.getAttribute('data-hydra') === id
            && document.querySelector('[data-connected=true]') && !document.querySelector('.error-banner'),
          })
          assert.equal(
            listHydras().length,
            count,
          )
        }

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

        if (recovery === 'reconnect') {
          const observed = await page.shows({
            what: 'the original creation attempt replayed after unknown delivery',
            check: () => {
              const control = window as unknown as {
                unknownSeen: boolean
                creationAttempts: string[]
              }

              return control.unknownSeen && control.creationAttempts
            },
          })
          assert.equal(
            observed.length,
            2,
          )
          assert.equal(
            observed[0],
            observed[1],
          )
          assert.equal(
            listHydras().filter(row => row.creationAttempt === observed[0]).length,
            1,
          )
        }

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
        await page.reload()
        await page.shows({
          what: 'the promoted draft after reloading its canonical URL',
          arg: canonical,
          check: ({ id }) => document.querySelector('main')?.getAttribute('data-hydra') === id
          && (document.querySelector('.hydra-chat textarea') as HTMLTextAreaElement | null)?.value === 'Keep this draft through creation',
        })
      } finally {
        fs.writeFileSync = write
        syncBuiltinESMExports()
        await page.close()
      }
    },
  )
}

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
