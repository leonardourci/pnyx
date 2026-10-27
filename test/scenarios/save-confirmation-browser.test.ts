import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup, until } from './harness.ts'

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
