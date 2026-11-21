import { afterEach, expect, test, vi } from 'vitest'
import { createSocketOutbox } from '#app/socket-outbox.ts'
import type { ServerMessage } from '#app/server-transport.ts'

afterEach(() => vi.useRealTimers())

function slowSocket({ bufferWrites = false }: { bufferWrites?: boolean } = {}) {
  let bufferedAmount = 10_000
  const sent: ServerMessage[] = []
  const disconnect = vi.fn()
  const socket = {
    get bufferedAmount() {
      return bufferedAmount
    },
    open: () => !disconnect.mock.calls.length,
    send({ text }: { text: string }) {
      sent.push(JSON.parse(text))

      if (bufferWrites) {
        bufferedAmount += Buffer.byteLength(text)
      }
    },
    disconnect,
  }
  const outbox = createSocketOutbox({
    socket,
    limit: 1_000,
  })

  return {
    ...outbox,
    sent,
    disconnect,
    drain() {
      bufferedAmount = 0
      vi.runOnlyPendingTimers()
    },
  }
}

test(
  'a slow socket retains receipts and errors in order',
  () => {
    vi.useFakeTimers()
    const socket = slowSocket()
    const messages: ServerMessage[] = [
      {
        type: 'receipt',
        id: 'saved-owner-message',
      },
      {
        type: 'error',
        id: 'other-message',
        error: 'Missing task',
        code: 'NOT_FOUND',
      },
      { type: 'pong' },
    ]

    for (const message of messages) {
      expect(socket.send({ message })).toBe(true)
    }

    expect(socket.sent).toEqual([])
    socket.drain()
    expect(socket.sent).toEqual(messages)
    expect(socket.disconnect).not.toHaveBeenCalled()
    socket.close()
  },
)

test(
  'activity retains every card within a subscription and keeps replacement subscriptions separate',
  () => {
    vi.useFakeTimers()
    const socket = slowSocket()
    const usage = {
      who: {
        provider: 'codex',
        icon: 'codex',
      },
      recorded: {
        unavailable: 0,
        sharedHydra: false,
      },
      windows: [],
    }
    const snapshot: ServerMessage = {
      type: 'latest',
      scope: 'one',
      subscription: 'current',
      messages: {
        first: {
          role: 'assistant',
          text: 'First reply',
        },
      },
      actions: {
        first: {
          calls: [],
          done: false,
        },
      },
      spend: {
        first: {
          total: 1,
          unavailable: 0,
          sharedHydra: false,
        },
      },
      usage: {first: usage},
    }
    socket.send({message: snapshot})
    socket.send({
      message: {
        type: 'latest',
        scope: 'one',
        subscription: 'replacement',
        messages: {replacement: null},
        actions: {},
      },
    })
    socket.send({
      message: {
        type: 'latest',
        scope: 'two',
        subscription: 'current',
        messages: {},
        actions: {},
      },
    })
    socket.send({
      message: {
        type: 'latest',
        scope: 'one',
        subscription: 'current',
        messages: {
          second: {
            role: 'assistant',
            text: 'Second reply',
          },
        },
        actions: {
          second: {
            calls: [],
            done: true,
          },
        },
        spend: {
          second: {
            total: 2,
            unavailable: 0,
            sharedHydra: false,
          },
        },
        usage: {second: usage},
      },
    })
    socket.send({
      message: {
        type: 'latest',
        scope: 'one',
        subscription: 'current',
        messages: {
          first: {
            role: 'assistant',
            text: 'Updated first reply',
          },
        },
        actions: {},
        spend: {
          first: {
            total: 3,
            unavailable: 0,
            sharedHydra: false,
          },
        },
      },
    })
    socket.drain()
    expect(socket.sent).toEqual([
      {
        type: 'latest',
        scope: 'one',
        subscription: 'replacement',
        messages: {replacement: null},
        actions: {},
      },
      {
        type: 'latest',
        scope: 'two',
        subscription: 'current',
        messages: {},
        actions: {},
      },
      {
        type: 'latest',
        scope: 'one',
        subscription: 'current',
        messages: {
          first: {
            role: 'assistant',
            text: 'Updated first reply',
          },
          second: {
            role: 'assistant',
            text: 'Second reply',
          },
        },
        actions: {
          first: {
            calls: [],
            done: false,
          },
          second: {
            calls: [],
            done: true,
          },
        },
        spend: {
          first: {
            total: 3,
            unavailable: 0,
            sharedHydra: false,
          },
          second: {
            total: 2,
            unavailable: 0,
            sharedHydra: false,
          },
        },
        usage: {
          first: usage,
          second: usage,
        },
      },
    ])
    socket.close()
  },
)

test(
  'activity stays on its side of a home state change',
  () => {
    vi.useFakeTimers()
    const socket = slowSocket()
    const before: ServerMessage = {
      type: 'latest',
      messages: {
        before: {
          role: 'assistant',
          text: 'Old session',
        },
      },
      actions: {},
    }
    const change: ServerMessage = {
      type: 'home.delta',
      cursor: {
        epoch: 'daemon',
        seq: 1,
      },
      changes: {
        set: {},
        nested: {},
        remove: [],
      },
    }
    const after: ServerMessage = {
      type: 'latest',
      messages: {
        after: {
          role: 'assistant',
          text: 'Other card',
        },
      },
      actions: {},
    }
    socket.send({ message: before })
    socket.send({ message: change })
    socket.send({ message: after })
    socket.drain()
    expect(socket.sent).toEqual([
      before,
      change,
      after,
    ])
    socket.close()
  },
)

test(
  'large snapshot activity is paced after home ready without disconnecting',
  () => {
    vi.useFakeTimers()
    const socket = slowSocket({ bufferWrites: true })
    const ready: ServerMessage = {
      type: 'home.ready',
      cursor: {
        epoch: 'daemon',
        seq: 1,
      },
    }
    const messages = Object.fromEntries(Array.from(
      { length: 100 },
      (
        _,
        id,
      ) => [
        String(id),
        {
          role: 'assistant' as const,
          text: 'x'.repeat(280),
        },
      ],
    ))
    expect(socket.send({ message: ready })).toBe(true)
    expect(socket.send({
      snapshot: true,
      message: {
        type: 'latest',
        messages,
        actions: {},
      },
    })).toBe(true)
    socket.drain()
    expect(socket.sent[0]).toEqual(ready)
    expect(socket.sent.length).toBeLessThan(Object.keys(messages).length)

    for (let i = 0; i < Object.keys(messages).length && vi.getTimerCount(); i += 1) {
      socket.drain()
    }

    const received = Object.assign(
      {},
      ...socket.sent.flatMap(frame => frame.type === 'latest' ? [frame.messages] : []),
    )
    expect(received).toEqual(messages)
    expect(socket.sent.every(frame => Buffer.byteLength(JSON.stringify(frame)) <= 1_000)).toBe(true)
    expect(socket.disconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    socket.close()
  },
)

test(
  'overflow disconnects the slow client so it can resume instead of losing a receipt',
  () => {
    vi.useFakeTimers()
    const socket = slowSocket()
    expect(socket.send({
      message: {
        type: 'receipt',
        id: 'first',
        text: 'x'.repeat(600),
      },
    })).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    expect(socket.send({
      message: {
        type: 'receipt',
        id: 'saved',
        text: 'x'.repeat(600),
      },
    })).toBe(false)
    expect(socket.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    socket.drain()
    expect(socket.sent).toEqual([])
    expect(socket.send({
      message: {
        type: 'receipt',
        id: 'later',
      },
    })).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  },
)
