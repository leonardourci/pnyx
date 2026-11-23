import { beforeAll, expect, test, vi } from 'vitest'
import type { ServerMessage } from '#app/server-transport.ts'
import { openPage, startPnyx, until, type Pnyx } from './setup/pnyx.ts'

const QUEUE_BYTES = 1_024
const PREVIEW_CARDS = 4
const PREVIEW = 'A preview from the provider transcript. '.repeat(8)
const pressure = vi.hoisted(() => ({
  active: false,
  paused: false,
  latest: 0,
  answerQueued: false,
  disconnects: 0,
  cards: [] as string[],
}))

vi.mock(
  '#app/socket-outbox.ts',
  async () => {
    const actual = await vi.importActual<typeof import('#app/socket-outbox.ts')>('#app/socket-outbox.ts')

    return {
      ...actual,
      createSocketOutbox({
        socket,
        ...options
      }: Parameters<typeof actual.createSocketOutbox>[0]) {
        if (!pressure.active) {
          return actual.createSocketOutbox({
            socket,
            ...options,
          })
        }

        const outbox = actual.createSocketOutbox({
          ...options,
          limit: QUEUE_BYTES,
          socket: {
            get bufferedAmount() {
              return pressure.paused ? QUEUE_BYTES : socket.bufferedAmount
            },
            open: socket.open,
            send({
              text,
              message,
            }) {
              socket.send({
                text,
                message,
              })

              if (message.type === 'home.snapshot') {
                pressure.paused = true
              }
            },
            disconnect() {
              pressure.disconnects += 1
              socket.disconnect()
            },
          },
        })

        return {
          ...outbox,
          send({
            message,
            snapshot,
          }: Parameters<typeof outbox.send>[0]) {
            if (message.type === 'receipt' || message.type === 'error') {
              pressure.answerQueued = true
            }

            if (message.type === 'latest' && pressure.cards.every(id => Object.hasOwn(
              message.messages,
              id,
            ))) {
              pressure.latest += 1
            }

            return outbox.send({
              message,
              snapshot,
            })
          },
        }
      },
    }
  },
)

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'a page interest refresh during paced activity preserves the handshake, previews and receipt',
  async () => {
    const hydra = await pnyx.hydra()
    const cards = new Set<string>()

    for (let i = 0; i < PREVIEW_CARDS; i += 1) {
      const key = `paced-${i}`
      pnyx.claude.plan({
        hydra: hydra.id,
        match: ({ text }) => text.includes(`Brief for ${key}`),
        reply: PREVIEW,
      })
      await hydra.startTask({ key })
      const id = await until({
        what: 'the task to reach the home feed',
        check: () => pnyx.home().scopes[hydra.id]?.state.keys[key],
      })
      cards.add(id)
    }

    const warmed: Record<string, string> = {}
    const warm = await openPage({
      port: pnyx.port(),
      hydraId: hydra.id,
      receive({ message }) {
        if (message.type === 'latest') {
          for (const [
            id,
            preview,
          ] of Object.entries(message.messages)) {
            if (preview) {
              warmed[id] = preview.text
            }
          }
        }
      },
    })

    try {
      await until({
        what: 'the provider previews to enter the server feed',
        check: () => [...cards].every(id => warmed[id]?.startsWith('A preview from the provider transcript.')),
      })
    } finally {
      warm.close()
    }

    const frames: ServerMessage[] = []
    pressure.cards = [...cards]
    pressure.active = true
    const page = await openPage({
      port: pnyx.port(),
      hydraId: hydra.id,
      home: true,
      receive: ({ message }) => frames.push(message),
    })

    try {
      await until({
        what: 'the snapshot activity to wait behind the home snapshot',
        check: () => pressure.latest >= 1 && frames.some(frame => frame.type === 'home.snapshot'),
      })
      pressure.answerQueued = false
      const answer = page.send({
        name: 'page',
        args: ['--hidden'],
      })
      void answer.catch(() => undefined)
      await until({
        what: 'the command answer to reach the paused socket',
        check: () => pressure.answerQueued,
      })
      pressure.paused = false
      expect(pressure.disconnects).toBe(0)
      expect(await answer).toMatchObject({
        type: 'receipt',
        unavailable: [],
      })
      await until({
        what: 'every provider preview on the same socket',
        check: () => {
          const received = Object.assign(
            {},
            ...frames.flatMap(frame => frame.type === 'latest' ? [frame.messages] : []),
          )

          return [...cards].every(id => received[id]?.text.startsWith('A preview from the provider transcript.'))
        },
      })
      const ready = frames.findIndex(frame => frame.type === 'home.ready')
      expect(ready).toBeGreaterThan(-1)
      expect(ready).toBeLessThan(frames.findIndex(frame => frame.type === 'latest'))
      expect(pressure.disconnects).toBe(0)
    } finally {
      pressure.paused = false
      pressure.active = false
      page.close()
    }
  },
)
