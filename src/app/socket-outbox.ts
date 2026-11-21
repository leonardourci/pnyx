import type { ServerMessage } from './server-transport.ts'

const MAX_SOCKET_BYTES = 1 << 20
const DRAIN_RETRY_MS = 100

interface Frame {
  message: ServerMessage
  bytes: number
  text: string
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
  const frames: Frame[] = []
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

  const drain = () => {
    timer = undefined

    if (closed || !socket.open()) {
      close()

      return
    }

    while (frames.length && socket.bufferedAmount < limit) {
      const frame = frames.shift()!
      bytes -= frame.bytes
      socket.send({
        text: frame.text,
        message: frame.message,
      })
    }

    if (frames.length) {
      timer = setTimeout(
        drain,
        DRAIN_RETRY_MS,
      )
      timer.unref()
    }
  }

  const send = ({ message }: { message: ServerMessage }): boolean => {
    if (closed || !socket.open()) {
      return false
    }

    if (message.type === 'latest') {
      const previous = frames.findLast(frame => frame.message.type === 'latest'
        && frame.message.scope === message.scope
        && frame.message.subscription === message.subscription)

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

    const text = JSON.stringify(message)
    const size = Buffer.byteLength(text)

    if (!frames.length && socket.bufferedAmount < limit) {
      socket.send({
        text,
        message,
      })

      return true
    }

    if (bytes + size > limit) {
      close()
      socket.disconnect()

      return false
    }

    frames.push({
      message,
      text,
      bytes: size,
    })
    bytes += size

    if (!timer) {
      timer = setTimeout(
        drain,
        DRAIN_RETRY_MS,
      )
      timer.unref()
    }

    return true
  }

  return {
    send,
    close,
  }
}
