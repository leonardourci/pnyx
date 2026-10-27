import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { build } from 'vite'
import { hydraIdentity, localToken } from '../../src/app/server-state.ts'
import type { Command } from '../../web/src/app/connection.ts'
import { browserGroup } from '../../src/test-harness/browser.ts'
import { scenarioGroup } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

for (const recovery of [
  'remount',
  'reconnect',
]) {
  test(
    `${recovery} recovers sent and queued edits with their original identities`,
    async () => {
      const s = await pnyx.scenario()
      const result = await build({
        configFile: false,
        logLevel: 'silent',
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        build: {
          write: false,
          minify: false,
          lib: {
            entry: join(
              import.meta.dirname,
              '../../web/src/app/fixtures/pending-hook.ts',
            ),
            formats: ['iife'],
            name: 'PendingHook',
          },
        },
      })
      const bundle = Array.isArray(result) ? result[0] : result
      assert.ok(bundle && 'output' in bundle)
      const script = bundle.output.find(file => file.type === 'chunk')
      assert.ok(script?.type === 'chunk')
      const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/missing-fixture.html` })
      await page.shows({
        what: 'the connection fixture mounted on its isolated Hydra origin',
        arg: {
          code: script.code,
          token: localToken(),
          identity: hydraIdentity({ hydraId: s.hydraId }),
          installation: hydraIdentity({ hydraId: '' }),
          hydraId: s.hydraId,
        },
        check: ({
          code,
          token,
          identity,
          installation,
          hydraId,
        }) => {
          if (document.readyState !== 'complete') {
            return false
          }

          history.replaceState(
            null,
            '',
            `/hydra/${hydraId}/`,
          )
          document.body.innerHTML = '<div id="root"></div>'

          for (const [
            name,
            content,
          ] of [
              [
                'pnyx-token',
                token,
              ],
              [
                'pnyx-hydra',
                identity,
              ],
              [
                'pnyx-installation',
                installation,
              ],
            ]) {
            const meta = document.createElement('meta')
            meta.name = name
            meta.content = content
            document.head.append(meta)
          }

          const script = document.createElement('script')
          script.textContent = code
          document.body.append(script)

          return true
        },
      })
      await page.shows({
        what: 'the fixture connected',
        check: () => JSON.parse(document.querySelector('#probe')?.textContent ?? '{}').connected,
      })
      await page.shows({
        what: 'one edit held in transport and a second queued before remount',
        check: () => {
          const control = window as unknown as {
            pendingFixture: {
              command: Command
              unmount(): void
            }
            renameIds: string[]
            disconnect(): void
          }
          const send = WebSocket.prototype.send
          control.renameIds = []

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes a single payload.
          WebSocket.prototype.send = function(data) {
            const message = JSON.parse(String(data))

            if (message.name === 'column' && message.args[0] === 'rename') {
              control.renameIds.push(message.id)

              if (control.renameIds.length === 1) {
                control.disconnect = () => this.close()

                return
              }
            }

            send.call(
              this,
              data,
            )
          }

          for (const [
            column,
            title,
          ] of [
              [
                'queued',
                'Retained first',
              ],
              [
                'in_progress',
                'Retained second',
              ],
            ]) {
            control.pendingFixture.command({
              name: 'column',
              args: [
                'rename',
                column,
                '--title',
                title,
              ],
            }).catch(() => {
            // Unmount rejects the old observer; the scoped resource retains delivery ownership.
            })
          }

          return true
        },
      })
      const before = await page.shows({
        what: 'both pending identities before teardown',
        check: () => {
          const state = JSON.parse(document.querySelector('#probe')?.textContent ?? '{}')

          return state.intents?.length === 2
            && state.intents.map((intent: { id: string }) => intent.id)
        },
      })
      await page.shows({
        what: 'recover the actual connection hook',
        arg: { recovery },
        check: ({ recovery }) => {
          const control = window as unknown as {
            pendingFixture: {
              mount(): void
              unmount(): void
            }
            disconnect(): void
          }

          if (recovery === 'remount') {
            control.pendingFixture.unmount()
            control.pendingFixture.mount()
          } else {
            control.disconnect()
          }

          return true
        },
      })
      await page.shows({
        what: 'both retained edits confirmed after remount',
        check: () => {
          const state = JSON.parse(document.querySelector('#probe')?.textContent ?? '{}')

          return state.connected && state.intents?.length === 2
          && state.intents.every((intent: { stage: string }) => intent.stage === 'confirmed')
        },
      })
      const sent = await page.shows({
        what: 'the original identity used on retry',
        check: () => (window as unknown as { renameIds: string[] }).renameIds,
      })
      assert.deepEqual(
        sent,
        [
          before[0],
          before[0],
          before[1],
        ],
      )
      const unknownSeen = await page.shows({
        what: 'the interrupted edit presented as unknown before recovery',
        check: () => {
          const { pendingFixture } = window as unknown as {
            pendingFixture: { unknownSeen: boolean }
          }

          return pendingFixture.unknownSeen
        },
      })
      assert.equal(
        unknownSeen,
        true,
      )
      assert.equal(
        s.state().config?.columns.find(column => column.role === 'queued')?.title,
        'Retained first',
      )
      assert.equal(
        s.state().config?.columns.find(column => column.role === 'in_progress')?.title,
        'Retained second',
      )

      for (const id of before) {
        assert.equal(
          s.events().filter(event => event.id === id).length,
          1,
        )
      }

      await page.shows({
        what: 'an unchanged edit acknowledged without an event',
        check: () => {
          const control = window as unknown as {
            pendingFixture: {
              command: Command
            }
            unchanged?: string
          }

          const save = async () => {
            try {
              const receipt = await control.pendingFixture.command({
                name: 'column',
                args: [
                  'rename',
                  'queued',
                  '--title',
                  'Retained first',
                ],
              })
              control.unchanged = String(receipt.event)
            } catch (error) {
              control.unchanged = String(error)
            }
          }

          save()

          return true
        },
      })
      await page.shows({
        what: 'unchanged acknowledgement settles its preview',
        check: () => {
          const control = window as unknown as { unchanged?: string }
          const state = JSON.parse(document.querySelector('#probe')?.textContent ?? '{}')

          return control.unchanged === 'none: unchanged'
          && state.intents.every((intent: { stage: string }) => intent.stage === 'confirmed')
        },
      })

      await page.close()
    },
  )
}

test(
  'a receipt keeps its preview and serializes the next revision until its event arrives',
  async () => {
    const s = await pnyx.scenario()
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.shows({
      what: 'the connected Hydra',
      check: () => document.querySelector('[data-connected=true]'),
    })
    await page.shows({
      what: 'hold the first rename event while delivering its receipt',
      check: () => {
        const send = WebSocket.prototype.send
        const control = window as unknown as {
          renameFrames: { args: string[] }[]
          receiptSeen: boolean
          releaseEvent(): void
        }
        control.renameFrames = []
        control.receiptSeen = false

        // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes a single payload.
        WebSocket.prototype.send = function(data) {
          const message = JSON.parse(String(data))

          if (message.name === 'column' && message.args[0] === 'rename') {
            control.renameFrames.push(message)

            if (control.renameFrames.length === 1) {
              const receive = this.onmessage!
              const held: MessageEvent[] = []
              const eventId = message.args[message.args.indexOf('--event-id') + 1]

              this.onmessage = event => {
                const response = JSON.parse(String(event.data))

                if (response.type === 'event' && response.event.id === eventId) {
                  held.push(event)

                  return
                }

                if (response.type === 'receipt' && response.id === message.id) {
                  control.receiptSeen = true
                }

                receive.call(
                  this,
                  event,
                )
              }

              control.releaseEvent = () => {
                this.onmessage = receive
                held.forEach(event => receive.call(
                  this,
                  event,
                ))
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

    for (const [
      column,
      title,
    ] of [
        [
          'queued',
          'Accepted first',
        ],
        [
          'in_progress',
          'Queued second',
        ],
      ]) {
      await page.click({ selector: `.column-${column} .inline-title` })
      await page.press({ key: 'Enter' })
      await page.type({ text: title })
      await page.press({ key: 'Enter' })
    }

    const before = await page.shows({
      what: 'receipt accepted with both previews and the second write still queued',
      check: () => {
        const control = window as unknown as {
          receiptSeen: boolean
          renameFrames: { args: string[] }[]
        }

        return control.receiptSeen && document.querySelector('.column-queued h2')?.textContent?.includes('Accepted first')
        && document.querySelector('.column-in_progress h2')?.textContent?.includes('Queued second')
        && document.querySelector('[data-pending=saving]') && { sent: control.renameFrames.length }
      },
    })
    assert.equal(
      before.sent,
      1,
    )
    const revision = s.state().configRevision
    assert.equal(
      s.state().config?.columns.find(column => column.role === 'in_progress')?.title,
      'In progress',
    )
    await page.shows({
      what: 'the durable event released',
      check: () => {
        (window as unknown as { releaseEvent(): void }).releaseEvent()

        return true
      },
    })
    await page.shows({
      what: 'both edits confirmed',
      check: () => !document.querySelector('[data-pending]'),
    })
    const frames = await page.shows({
      what: 'the second outgoing frame uses the confirmed revision',
      check: () => (window as unknown as { renameFrames: { args: string[] }[] }).renameFrames,
    })
    assert.equal(
      frames.length,
      2,
    )
    const args = frames[1]!.args
    assert.equal(
      args[args.indexOf('--if-revision') + 1],
      String(revision),
    )
    assert.equal(
      s.state().config?.columns.find(column => column.role === 'in_progress')?.title,
      'Queued second',
    )
    await page.close()
  },
)

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
          releaseCreate: () => void
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
      check: () => {
        ;(window as unknown as { releaseCreate: () => void }).releaseCreate()

        return true
      },
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
