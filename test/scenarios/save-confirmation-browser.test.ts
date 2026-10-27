import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { HELPER_INSTRUCTIONS } from '../../src/helper/runner.ts'
import { hydraDir } from '../../src/app/home-migration.ts'
import { browserGroup } from '../../src/test-harness/browser.ts'
import { openPage, scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()
type Page = Awaited<ReturnType<typeof chrome.open>>

interface SaveProbe {
  message?: {
    id: string
    name: string
    args: string[]
  }
  held: MessageEvent[]
  expire(): void
  release(): void
  disconnect(): void
}

const holdSave = ({
  page,
  drop = false,
  events = false,
}: {
  page: Page
  drop?: boolean
  events?: boolean
}) => page.shows({
  what: 'save transport control',
  arg: {
    drop,
    events,
  },
  check: ({
    drop,
    events,
  }) => {
    const win = window as typeof window & { saveProbe: SaveProbe }
    const timers = new Map<number, () => void>()
    const saveTimers = new Set<number>()
    let lastTimer = 0
    const schedule = window.setTimeout
    const cancel = window.clearTimeout

    window.setTimeout = Object.assign(
      // eslint-disable-next-line pnyx/object-params -- The browser owns the timer signature.
      (
        handler: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) => {
        const id = schedule(
          handler,
          delay,
          ...args,
        )

        if (delay === 60000 && typeof handler === 'function') {
          lastTimer = id
          timers.set(
            id,
            () => handler(...args),
          )
        }

        return id
      },
      schedule,
    )

    // eslint-disable-next-line pnyx/object-params -- The browser owns the timer signature.
    window.clearTimeout = id => {
      if (typeof id === 'number') {
        timers.delete(id)
        saveTimers.delete(id)
      }

      cancel(id)
    }

    let disconnect = () => {}
    const probe: SaveProbe = {
      held: [],
      expire: () => {
        const due = [...timers.entries()].filter(([id]) => saveTimers.has(id))

        for (const [
          id,
          run,
        ] of due) {
          window.clearTimeout(id)
          run()
        }
      },
      release: () => {
        drop = false
        disconnect()
      },
      disconnect: () => disconnect(),
    }
    win.saveProbe = probe
    const send = WebSocket.prototype.send

    // eslint-disable-next-line pnyx/object-params -- The browser owns WebSocket.send's signature.
    WebSocket.prototype.send = function (data) {
      const message = JSON.parse(String(data))
      const saving = message.type === 'command' && (message.name === 'hydra-agent'
        || message.name === 'hydra' && message.args[0] === 'send')

      if (!saving) {
        return send.call(
          this,
          data,
        )
      }

      saveTimers.add(lastTimer)
      disconnect = () => this.close()

      if (drop) {
        if (!probe.message) {
          probe.message = message
        }

        return
      }

      if (probe.message) {
        return send.call(
          this,
          data,
        )
      }

      probe.message = message

      const receive = this.onmessage!

      this.onmessage = event => {
        const answer = JSON.parse(String(event.data))
        const receipt = answer.id === message.id && [
          'receipt',
          'error',
        ].includes(answer.type)
        const state = events && [
          'event',
          'snapshot',
        ].includes(answer.type)

        if (receipt || state) {
          probe.held.push(event)

          return
        }

        receive.call(
          this,
          event,
        )
      }

      probe.release = () => {
        this.onmessage = receive

        for (const event of probe.held.splice(0)) {
          receive.call(
            this,
            event,
          )
        }
      }

      return send.call(
        this,
        data,
      )
    }

    return true
  },
})

const openHydra = async ({ s }: { s: Awaited<ReturnType<typeof pnyx.scenario>> }) => {
  await s.chat({ text: 'Warm this Hydra.' })
  const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
  await until({
    what: 'the initial settings save',
    check: () => {
      const agent = s.state().config?.hydra.agent

      return agent?.model && agent.effort && agent.mode && agent.fast === false
    },
  })
  await page.shows({
    what: 'the connected composer and settings',
    check: () => document.querySelector('.hydra-chat textarea')
      && document.querySelector('button[aria-label="Fast mode"]:not(:disabled)'),
  })

  return page
}

const sendChat = async ({
  page,
  text,
}: {
  page: Page
  text: string
}) => {
  await page.click({ selector: '.hydra-chat textarea' })
  await page.type({ text })
  await page.press({ key: 'Enter' })
}

const expireSave = ({ page }: { page: Page }) => page.shows({
  what: 'the save deadline',
  check: () => {
    const win = window as typeof window & { saveProbe: SaveProbe }
    win.saveProbe.expire()

    return true
  },
})

const confirmed = ({ page }: { page: Page }) => page.shows({
  what: 'a confirmed save with no failure or checking state',
  check: () => document.querySelector('.hydra-chat form')?.getAttribute('aria-busy') === 'false'
    && !document.querySelector('.save-checking, .send-error, .error-banner'),
})

test(
  'a saved chat event confirms the composer even when its receipt is lost',
  async () => {
    const s = await pnyx.scenario()
    const page = await openHydra({ s })
    await holdSave({ page })
    await sendChat({
      page,
      text: 'Saved without its receipt.',
    })
    await until({
      what: 'the real saved message',
      check: () => s.state().hydraMessages?.some(m => m.text === 'Saved without its receipt.'),
    })
    await confirmed({ page })
    await expireSave({ page })
    await confirmed({ page })
    assert.equal(
      s.events().filter(e => e.type === 'hydra.message' && e.data.text === 'Saved without its receipt.').length,
      1,
    )
    await page.close()
  },
)

test(
  'an unconfirmed chat stays checking until its late saved event clears the banner',
  async () => {
    const s = await pnyx.scenario()
    const page = await openHydra({ s })
    await holdSave({
      page,
      events: true,
    })
    await sendChat({
      page,
      text: 'Check this save, then confirm it.',
    })
    await until({
      what: 'the real saved message',
      check: () => s.state().hydraMessages?.some(m => m.text === 'Check this save, then confirm it.'),
    })
    await expireSave({ page })
    await page.shows({
      what: 'checking without a false failed send',
      check: () => document.querySelector('.hydra-chat .save-checking') && !document.querySelector('.send-error'),
    })
    await page.shows({
      what: 'late confirmation',
      check: () => {
        (window as typeof window & { saveProbe: SaveProbe }).saveProbe.release()

        return true
      },
    })
    await confirmed({ page })
    assert.equal(
      s.events().filter(e => e.type === 'hydra.message' && e.data.text === 'Check this save, then confirm it.').length,
      1,
    )
    await page.close()
  },
)

for (const settings of [
  false,
  true,
]) {
  for (const reconnect of [
    false,
    true,
  ]) {
    for (const committed of [
      false,
      true,
    ]) {
      test(
        `an ${committed ? 'already saved' : 'unconfirmed'} ${settings ? 'settings save' : 'chat'} survives ${reconnect ? 'reconnect' : 'reload'} with its original ID`,
        async () => {
          const s = await pnyx.scenario()
          const page = await openHydra({ s })
          await holdSave({
            page,
            drop: !committed,
            events: committed,
          })

          if (settings) {
            await page.click({ selector: 'button[aria-label="Fast mode"]' })
          } else {
            await page.shows({
              what: 'a comment from another tab',
              check: () => {
                const hydraId = location.pathname.split('/')[2]
                const key = `pnyx:${hydraId}:comments`
                const newValue = JSON.stringify({
                  $hydra: [
                    {
                      id: 'release-comment',
                      messageId: 'recorded-reply',
                      block: 0,
                      offset: 0,
                      quote: 'Recorded reply.',
                      text: 'Include a rollout check.',
                    },
                  ],
                })
                localStorage.setItem(
                  key,
                  newValue,
                )
                dispatchEvent(new StorageEvent(
                  'storage',
                  {
                    key,
                    newValue,
                  },
                ))

                return true
              },
            })
            await page.shows({
              what: 'the attached comment',
              check: () => document.querySelector('.composer-comments'),
            })
            await sendChat({
              page,
              text: 'Keep this attempt through reload.',
            })
          }

          const attempt = await page.shows({
            what: 'the pending operation identity',
            check: () => (window as typeof window & { saveProbe: SaveProbe }).saveProbe.message,
          })
          const id = settings ? attempt.id : attempt.args[attempt.args.indexOf('--event-id') + 1]

          if (committed) {
            await until({
              what: 'the operation committed without confirmation',
              check: () => s.events().some(e => e.id === id),
            })
          }

          if (reconnect) {
            await page.shows({
              what: 'the socket disconnect',
              check: () => {
                (window as typeof window & { saveProbe: SaveProbe }).saveProbe.disconnect()

                return true
              },
            })
          } else {
            await expireSave({ page })
          }

          await page.shows({
            what: 'the unconfirmed save',
            check: () => document.querySelector('.save-checking') && !document.querySelector('.send-error'),
          })

          if (reconnect) {
            await page.shows({
              what: 'reconnection allowed',
              check: () => {
                (window as typeof window & { saveProbe: SaveProbe }).saveProbe.release()

                return true
              },
            })
          } else {
            await page.reload()
          }

          await confirmed({ page })
          await until({
            what: 'the original operation saved once',
            check: () => s.events().some(e => e.id === id),
          })
          assert.equal(
            s.events().filter(e => e.id === id).length,
            1,
          )

          if (settings) {
            assert.equal(
              s.state().config?.hydra.agent?.fast,
              true,
            )
            assert.equal(
              s.events().find(e => e.id === id)?.type,
              'board.configured',
            )
          } else {
            assert.equal(
              s.state().hydraMessages?.filter(m => m.text.includes('Keep this attempt through reload.') && m.text.includes('Include a rollout check.')).length,
              1,
            )
            const hydra = await s.agent({ hydra: true })
            await until({
              what: 'the fake model receiving the restored reply',
              check: () => s.received({ cwd: hydra.cwd }).some(text => text.includes('Keep this attempt through reload.')),
            })
            assert.equal(
              s.received({ cwd: hydra.cwd }).filter(text => text.includes('Keep this attempt through reload.')).length,
              1,
            )
          }

          await page.close()
        },
      )
    }
  }
}

test(
  'a definite pre-save rejection restores the draft and reports it as not sent',
  async () => {
    const s = await pnyx.scenario()
    const page = await openHydra({ s })
    await page.shows({
      what: 'a request that the server will refuse before saving',
      check: () => {
        const send = WebSocket.prototype.send

        // eslint-disable-next-line pnyx/object-params -- The browser owns WebSocket.send's signature.
        WebSocket.prototype.send = function (data) {
          const message = JSON.parse(String(data))

          if (message.type === 'command' && message.name === 'hydra' && message.args[0] === 'send') {
            message.args[1] = '--text='
            WebSocket.prototype.send = send

            return send.call(
              this,
              JSON.stringify(message),
            )
          }

          return send.call(
            this,
            data,
          )
        }

        return true
      },
    })
    await sendChat({
      page,
      text: 'Keep this refused draft.',
    })
    await page.shows({
      what: 'the definite rejection and restored draft',
      check: () => document.querySelector('.send-error')?.textContent?.includes('Not sent')
      && document.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.value === 'Keep this refused draft.'
      && !document.querySelector('.save-checking'),
    })
    assert.equal(
      s.state().hydraMessages?.some(m => m.text === 'Keep this refused draft.'),
      false,
    )
    await page.close()
  },
)

test(
  'settings confirm by their saved operation and replaying that ID cannot revert a newer choice',
  async () => {
    const s = await pnyx.scenario()
    const page = await openHydra({ s })
    await holdSave({ page })
    await page.click({ selector: 'button[aria-label="Fast mode"]' })
    await until({
      what: 'fast mode saved',
      check: () => s.state().config?.hydra.agent?.fast === true,
    })
    const attempt = await page.shows({
      what: 'settings operation',
      check: () => (window as typeof window & { saveProbe: SaveProbe }).saveProbe.message,
    })
    await page.shows({
      what: 'confirmed settings',
      check: () => document.querySelector('button[aria-label="Fast mode"]:not(:disabled)'),
    })
    assert.equal(
      s.events().find(e => e.id === attempt.id)?.type,
      'board.configured',
    )
    await expireSave({ page })
    await confirmed({ page })
    const transport = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await transport.command({
      name: 'hydra-agent',
      args: [
        JSON.stringify({
          harness: 'claude',
          fast: false,
        }),
      ],
    })
    await page.shows({
      what: 'replaying the old save ID',
      arg: attempt,
      check: ({ ...attempt }) => {
        const ws = new WebSocket(`ws://${location.host}/hydra/${location.pathname.split('/')[2]}/ws?token=${document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')!.content}`)
        ws.onopen = () => ws.send(JSON.stringify(attempt))

        ws.onmessage = event => {
          if (JSON.parse(String(event.data)).id === attempt.id) {
            ws.close()
            document.documentElement.dataset.replayed = attempt.id
          }
        }

        return true
      },
    })
    await page.shows({
      what: 'the replay receipt',
      check: () => document.documentElement.dataset.replayed,
    })
    assert.equal(
      s.state().config?.hydra.agent?.fast,
      false,
    )
    assert.equal(
      s.events().filter(e => e.id === attempt.id).length,
      1,
    )
    transport.close()
    await page.close()
  },
)

test(
  'a busy routine helper does not hold an owner save acknowledgement',
  async () => {
    const s = await pnyx.scenario()
    await s.chat({ text: 'Warm main.' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
      ],
    })
    await s.owner({
      args: [
        'hydra',
        'set',
        '--helper',
        'claude',
      ],
    })
    const task = s.state().keys.work!
    const held = pnyx.claude.plan({
      text: HELPER_INSTRUCTIONS,
      hold: true,
      reply: JSON.stringify({
        outcomes: [
          {
            task,
            audience: 'routine',
            summary: 'Progress checked.',
          },
        ],
      }),
    })

    try {
      await s.owner({
        args: [
          'hydra',
          'send',
          '--task',
          task,
          '--kind',
          'progress',
          '--actor',
          `worker:${task}`,
          '--text',
          'Routine progress.',
        ],
      })
      await until({
        what: 'helper received its held prompt',
        check: () => s.received({
          cwd: join(
            hydraDir({ hydraId: s.hydraId }),
            'helper',
          ),
        }).some(text => text.endsWith(HELPER_INSTRUCTIONS)),
      })
      const page = await openHydra({ s })
      await sendChat({
        page,
        text: 'Owner sends while helper runs.',
      })
      await confirmed({ page })
      assert.equal(
        s.events().some(e => e.type === 'hydra.helper-finished'),
        false,
      )
      assert.equal(
        s.state().hydraMessages?.filter(m => m.text === 'Owner sends while helper runs.').length,
        1,
      )
      assert.notEqual(
        s.state().cards[HYDRA_CARD]?.sessionActivity,
        'interrupted',
      )
      await page.close()
    } finally {
      held.release()
    }
  },
)
