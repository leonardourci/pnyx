import { beforeAll, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerMessage } from '#app/server-transport.ts'
import { titanIdentity, localToken } from '#app/server-state.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { createTitanConnection } from '../web/src/app/connection-store.ts'
import { startOthrys, until, type Othrys } from './setup/othrys.ts'

vi.mock(
  '#web-app/log.ts',
  () => ({
    log: () => {},
    setLogMode: () => {},
    startPageLog: () => () => {},
    takeFrames: () => ({}),
  }),
)

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

test(
  'a client resumes an unchanged home with only ready and retains every Titan state',
  async () => {
    const primary = await othrys.titan()
    const background = await othrys.titan()
    await background.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'saved',
        '--title',
        'Saved before disconnect',
      ],
    })
    const task = await background.task({ key: 'saved' })
    const sockets: {
      socket: WebSocket
      url: URL
      frames: ServerMessage[]
    }[] = []

    class ClientSocket extends WebSocket {
      // eslint-disable-next-line othrys/object-params -- WebSocket owns its constructor signature.
      constructor(url: URL) {
        super(url)
        const frames: ServerMessage[] = []
        this.on(
          'message',
          text => frames.push(JSON.parse(String(text))),
        )
        sockets.push({
          socket: this,
          url,
          frames,
        })
      }
    }

    const events = new EventTarget()
    const document = Object.assign(
      new EventTarget(),
      {
        visibilityState: 'visible',
        // eslint-disable-next-line othrys/object-params -- Document owns the selector signature.
        querySelector: (selector: string) => {
          const content = {
            'meta[name=othrys-installation]': titanIdentity({ titanId: '' }),
            'meta[name=othrys-titan]': primary.id,
            'meta[name=othrys-token]': localToken(),
          }[selector]

          return content ? {
            content,
            setAttribute: () => {},
          } : null
        },
      },
    )
    vi.stubGlobal(
      'document',
      document,
    )
    vi.stubGlobal(
      'window',
      events,
    )
    vi.stubGlobal(
      'addEventListener',
      events.addEventListener.bind(events),
    )
    vi.stubGlobal(
      'removeEventListener',
      events.removeEventListener.bind(events),
    )
    vi.stubGlobal(
      'location',
      new URL(`http://127.0.0.1:${othrys.port()}/titan/${primary.id}/`),
    )
    vi.stubGlobal(
      'WebSocket',
      ClientSocket,
    )
    const client = createTitanConnection()
    const stop = client.start()
    const connected = () => [
      primary.id,
      background.id,
    ].every(id => client.workspaces()
      .some(workspace => workspace.navigation.titanId === id && workspace.connected))
    const taskCards = () => client.workspaces().map(workspace => ({
      titan: workspace.navigation.titanId,
      cards: Object.values(workspace.state.cards).filter(card => card.id !== TITAN_CARD)
        .map(card => ({
          id: card.id,
          title: card.title,
          project: card.project,
        })),
    }))

    try {
      await until({
        what: 'both Titan subscriptions to become current',
        check: connected,
      })
      const initial = sockets[0]!
      const ready = initial.frames.findLast(frame => frame.type === 'home.ready')!

      if (ready.type !== 'home.ready') {
        throw new Error('The initial home did not become ready')
      }

      const saved = client.workspaces().find(
        workspace => workspace.navigation.titanId === background.id,
      )!
      const state = saved.state
      const cards = taskCards()
      expect(state.cards[task.id]?.title).toBe('Saved before disconnect')
      initial.socket.close()
      await until({
        what: 'the same home cursor to reconnect',
        check: () => sockets.length === 2 && sockets[1]!.frames.some(frame => frame.type === 'home.ready')
          && connected(),
      })
      const resumed = sockets[1]!
      expect(JSON.parse(resumed.url.searchParams.get('cursor')!)).toEqual(ready.cursor)
      expect(resumed.frames.filter(frame => frame.type.startsWith('home.'))).toEqual([ready])
      const current = client.workspaces().find(
        workspace => workspace.navigation.titanId === background.id,
      )!
      expect(current.state.seq).toBe(state.seq)
      expect(taskCards()).toEqual(cards)
      expect(current.state.cards[task.id]?.title).toBe('Saved before disconnect')
    } finally {
      stop()

      for (const { socket } of sockets) {
        socket.terminate()
      }

      vi.unstubAllGlobals()
    }
  },
)
