import type { ServerMessage } from './server-transport.ts'

export const MAX_SOCKET_BYTES = 1 << 20
const DRAIN_RETRY_MS = 100

interface Frame {
  message: ServerMessage
  bytes: number
  text: string
}

interface ActivitySnapshot {
  cardFrames: Iterator<Frame>
  scope?: string
}

function encode({ message }: { message: ServerMessage }): Frame {
  const text = JSON.stringify(message)

  return {
    message,
    text,
    bytes: Buffer.byteLength(text),
  }
}

function* activityFrames({ message }: { message: Extract<ServerMessage, { type: 'latest' }> }): Generator<Frame> {
  const ids = new Set([
    ...Object.keys(message.messages),
    ...Object.keys(message.actions),
    ...Object.keys(message.spend ?? {}),
    ...Object.keys(message.usage ?? {}),
  ])

  for (const id of ids) {
    const select = <Value>({ values }: { values?: Record<string, Value> }) =>
      values && Object.hasOwn(
        values,
        id,
      ) ? { [id]: values[id]! } : {}
    yield encode({
      message: {
        ...message,
        messages: select({ values: message.messages }),
        actions: select({ values: message.actions }),
        spend: select({ values: message.spend }),
        usage: select({ values: message.usage }),
      },
    })
  }
}

export function createSocketOutbox({
  socket,
  limit = MAX_SOCKET_BYTES,
}: {
  socket: {
    bufferedAmount: number
    open(): boolean
    send({
      text,
      message,
    }: {
      text: string
      message: ServerMessage
    }): void
    disconnect(): void
  }
  limit?: number
}) {
  const frames: (Frame | ActivitySnapshot)[] = []
  let bytes = 0
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const close = () => {
    closed = true
    clearTimeout(timer)
    timer = undefined
    frames.length = 0
    bytes = 0
  }

  const scheduleDrain = () => {
    if (!timer) {
      timer = setTimeout(
        drain,
        DRAIN_RETRY_MS,
      )
      timer.unref()
    }
  }

  const drain = () => {
    timer = undefined

    if (closed || !socket.open()) {
      close()

      return
    }

    while (frames.length && socket.bufferedAmount < limit) {
      const next = frames[0]!
      let frame: Frame

      if ('cardFrames' in next) {
        const item = next.cardFrames.next()

        if (item.done) {
          frames.shift()

          continue
        }

        frame = item.value
      } else {
        frame = next
        frames.shift()
        bytes -= frame.bytes
      }

      socket.send({
        text: frame.text,
        message: frame.message,
      })
    }

    if (frames.length) {
      scheduleDrain()
    }
  }

  const send = ({
    message,
    snapshot = false,
  }: {
    message: ServerMessage
    snapshot?: boolean
  }): boolean => {
    if (closed || !socket.open()) {
      return false
    }

    if (message.type === 'latest') {
      let previous: Frame | undefined

      for (let i = frames.length - 1; i >= 0; i -= 1) {
        const frame = frames[i]!

        if ('cardFrames' in frame || frame.message.type === 'home.delta' || frame.message.type === 'home.snapshot') {
          break
        }

        if (frame.message.type === 'latest' && frame.message.scope === message.scope
          && frame.message.subscription === message.subscription) {
          previous = frame

          break
        }
      }

      if (previous?.message.type === 'latest') {
        message = {
          ...previous.message,
          ...message,
          messages: {
            ...previous.message.messages,
            ...message.messages,
          },
          actions: {
            ...previous.message.actions,
            ...message.actions,
          },
          spend: {
            ...previous.message.spend,
            ...message.spend,
          },
          usage: {
            ...previous.message.usage,
            ...message.usage,
          },
        }
        frames.splice(
          frames.indexOf(previous),
          1,
        )
        bytes -= previous.bytes
      }
    }

    const frame = encode({ message })

    if (snapshot && message.type === 'latest' && frame.bytes + bytes > limit) {
      const previous = frames.findIndex(item => 'cardFrames' in item && item.scope === message.scope)

      if (previous !== -1) {
        frames.splice(
          previous,
          1,
        )
      }

      frames.push({
        cardFrames: activityFrames({ message }),
        scope: message.scope,
      })
      scheduleDrain()

      return true
    }

    if (!frames.length && socket.bufferedAmount < limit) {
      socket.send({
        text: frame.text,
        message,
      })

      return true
    }

    if (bytes + frame.bytes > limit) {
      close()
      socket.disconnect()

      return false
    }

    frames.push(frame)
    bytes += frame.bytes
    scheduleDrain()

    return true
  }

  return {
    send,
    close,
  }
}
