import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { localToken } from '#app/server-state.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import { until } from './until.ts'

export async function openPage({
  port,
  hydraId,
  cards,
  token = localToken(),
  home = false,
  cursor,
  receive,
}: {
  port: number
  hydraId?: string
  cards?: string[]
  token?: string
  home?: boolean
  cursor?: import('#app/socket-history.ts').SocketCursor
  receive?({ message }: { message: ServerMessage }): void
}) {
  const params = new URLSearchParams({ token })

  if (cards) {
    params.set(
      'page',
      JSON.stringify(cards),
    )
  }

  if (home) {
    params.set(
      'home',
      '1',
    )
  }

  if (cursor) {
    params.set(
      'cursor',
      JSON.stringify(cursor),
    )
  }

  const path = hydraId ? `/hydra/${hydraId}/ws` : '/ws'
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?${params}`)
  const answers = new Map<string, ServerMessage>()
  socket.on(
    'message',
    (data: unknown) => {
      const message = JSON.parse(String(data)) as ServerMessage
      receive?.({ message })

      if ((message.type === 'receipt' || message.type === 'error') && message.id) {
        answers.set(
          message.id,
          message,
        )
      }
    },
  )
  await new Promise((
    resolve,
    reject,
  ) => {
    socket.once(
      'open',
      resolve,
    )
    socket.once(
      'error',
      reject,
    )
  })

  const send = ({
    name,
    args,
  }: {
    name: string
    args: string[]
  }) => {
    const id = `page-${randomUUID()}`
    socket.send(JSON.stringify({
      type: 'command',
      id,
      name,
      args,
    }))

    return until({
      what: `the answer to ${name} ${args.join(' ')}`,
      check: () => {
        const answer = answers.get(id)

        if (!answer && socket.readyState === WebSocket.CLOSED) {
          throw new Error(`Page connection to Hydra ${hydraId ?? 'default'} closed while waiting for ${name} ${args.join(' ')}`)
        }

        return answer
      },
    })
  }

  return {
    send,
    close: () => socket.close(),
  }
}
