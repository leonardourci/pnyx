import { afterEach, expect, test, vi } from 'vitest'
import { createSocketOutbox } from '#app/socket-outbox.ts'
import type { ServerMessage } from '#app/server-transport.ts'

afterEach(() => vi.useRealTimers())

function slowSocket() {
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
      vi.advanceTimersByTime(100)
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
  'activity coalesces within its Hydra subscription while other scopes remain separate',
  () => {
    vi.useFakeTimers()
    const socket = slowSocket()
    const latest = {
      type: 'latest',
      messages: {},
      actions: {},
    } as const
    socket.send({
      message: {
        ...latest,
        scope: 'one',
        spend: {
          task: {
            total: 1,
            unavailable: 0,
            sharedHydra: false,
          },
        },
      },
    })
    socket.send({
      message: {
        ...latest,
        scope: 'two',
      },
    })
    socket.send({
      message: {
        ...latest,
        scope: 'one',
        spend: {
          task: {
            total: 2,
            unavailable: 0,
            sharedHydra: false,
          },
        },
      },
    })
    socket.drain()
    expect(socket.sent.map(message => message.scope)).toEqual([
      'two',
      'one',
    ])
    expect(socket.sent.at(-1)).toMatchObject({
      spend: {
        task: {
          total: 2,
          unavailable: 0,
          sharedHydra: false,
        },
      },
    })
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
        id: 'saved',
        text: 'x'.repeat(1_000),
      },
    })).toBe(false)
    expect(socket.disconnect).toHaveBeenCalledOnce()
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
