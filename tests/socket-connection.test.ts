import { beforeAll, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerMessage } from '#app/server-transport.ts'
import { titanIdentity, localToken } from '#app/server-state.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { createTitanConnection } from '#web-app/connection-store.ts'
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

type Frame = {
  socket: WebSocket
  url: URL
  frames: ServerMessage[]
}

function connectPage({ primary }: { primary: string }) {
  const sockets: Frame[] = []

  class ClientSocket extends WebSocket {
    constructor({ href }: URL) {
      super(href)
      const frames: ServerMessage[] = []
      this.on(
        'message',
        text => frames.push(JSON.parse(String(text))),
      )
      sockets.push({
        socket: this,
        url: new URL(href),
        frames,
      })
    }
  }

  const events = new EventTarget()
  const metadata = new Map(Object.entries({
    'meta[name=othrys-installation]': titanIdentity({ titanId: '' }),
    'meta[name=othrys-titan]': primary,
    'meta[name=othrys-token]': localToken(),
  }).map(([
    selector,
    content,
  ]) => [
    selector,
    {
      content,
      setAttribute: () => {},
    },
  ]))
  const document = Object.assign(
    new EventTarget(),
    {
      visibilityState: 'visible',
      querySelector: metadata.get.bind(metadata),
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
    new URL(`http://127.0.0.1:${othrys.port()}/titan/${primary}/`),
  )
  vi.stubGlobal(
    'WebSocket',
    ClientSocket,
  )
  const client = createTitanConnection()
  const stop = client.start()

  return {
    client,
    sockets,
    close: () => {
      stop()

      for (const { socket } of sockets) {
        socket.terminate()
      }

      vi.unstubAllGlobals()
    },
  }
}

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
    const {
      client,
      sockets,
      close,
    } = connectPage({ primary: primary.id })
    const connected = () => [
      primary.id,
      background.id,
    ].every(id => client.shownWorkspaces()
      .some(workspace => workspace.navigation.titanId === id && workspace.connected))
    const taskCards = () => client.shownWorkspaces().map(workspace => ({
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

      const saved = client.shownWorkspaces().find(
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
      const current = client.shownWorkspaces().find(
        workspace => workspace.navigation.titanId === background.id,
      )!
      expect(current.state.seq).toBe(state.seq)
      expect(taskCards()).toEqual(cards)
      expect(current.state.cards[task.id]?.title).toBe('Saved before disconnect')
    } finally {
      close()
    }
  },
)

test(
  'a read that changes nothing keeps the page snapshot, and another Titan\'s change still reaches the page',
  async () => {
    const primary = await othrys.titan()
    const background = await othrys.titan()
    const {
      client,
      close,
    } = connectPage({ primary: primary.id })
    const shown = ({ id }: { id: string }) => client.shownWorkspaces()
      .find(workspace => workspace.navigation.titanId === id)
    let notified = false
    const unsubscribe = client.subscribe(() => {
      notified = true
    })

    try {
      await until({
        what: 'both Titans to connect',
        check: () => [
          primary.id,
          background.id,
        ].every(id => !!shown({ id })?.connected),
      })
      const snapshot = client.snapshot()
      const workspaces = client.shownWorkspaces()
      notified = false
      await client.commandFor({ id: primary.id })({
        name: 'rule',
        args: ['list'],
      })
      expect(client.snapshot()).toBe(snapshot)
      expect(client.shownWorkspaces()).toBe(workspaces)
      expect(notified).toBe(false)

      await background.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--key',
          'elsewhere',
          '--title',
          'Made in the other Titan',
        ],
      })
      const task = await background.task({ key: 'elsewhere' })
      await until({
        what: 'the other Titan\'s new task to reach the page',
        check: () => shown({ id: background.id })?.state.cards[task.id]?.title === 'Made in the other Titan',
      })
      expect(notified).toBe(true)
    } finally {
      unsubscribe()
      close()
    }
  },
)

test(
  'a worker chat closed on the page keeps its loaded page for when it opens again',
  async () => {
    const primary = await othrys.titan()
    await primary.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'reopened',
        '--title',
        'Opened twice',
      ],
    })
    const task = await primary.task({ key: 'reopened' })
    const {
      client,
      close,
    } = connectPage({ primary: primary.id })
    const command = client.commandFor({ id: primary.id })
    const thread = () => client.shownWorkspaces()
      .find(workspace => workspace.navigation.titanId === primary.id)?.taskThreads[task.id]

    try {
      await until({
        what: 'the Titan to connect',
        check: () => !!client.snapshot().connected,
      })
      await command({
        name: 'page',
        args: [
          '--card',
          task.id,
        ],
      })
      await command({
        name: 'thread',
        args: [task.id],
      })
      await until({
        what: 'the worker chat page to load',
        check: () => thread()?.card === task.id,
      })
      await command({
        name: 'page',
        args: [],
      })
      expect(thread()?.card).toBe(task.id)
      await command({
        name: 'page',
        args: [
          '--card',
          task.id,
        ],
      })
      expect(thread()?.card).toBe(task.id)
    } finally {
      close()
    }
  },
)
