import { createConnection, createServer, type Socket } from 'node:net'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ToHost, ToClient } from '#agent-host/protocol.ts'

export async function loseInputReply({
  directory,
  text,
  holdAttach = false,
}: {
  directory: string
  text: string
  holdAttach?: boolean
}) {
  const socket = join(
    directory,
    'host.sock',
  )
  const upstream = join(
    directory,
    'upstream.sock',
  )
  renameSync(
    socket,
    upstream,
  )
  const connections = new Set<Socket>()
  let dropped = false
  let target: string | undefined
  let heldReply: (() => void) | undefined
  let heldOnce = false
  const server = createServer(down => {
    const up = createConnection(upstream)
    connections.add(down)
    connections.add(up)
    down.setEncoding('utf8')
    up.setEncoding('utf8')
    let requests = '', responses = '', requestId: string | undefined, attachId: string | undefined

    const close = () => {
      down.destroy()
      up.destroy()
      connections.delete(down)
      connections.delete(up)
    }

    down.on(
      'error',
      close,
    )
    up.on(
      'error',
      close,
    )
    down.on(
      'close',
      close,
    )
    up.on(
      'close',
      close,
    )
    down.on(
      'data',
      chunk => {
        requests += chunk
        let newline = requests.indexOf('\n')

        while (newline >= 0) {
          const line = requests.slice(
            0,
            newline,
          )
          requests = requests.slice(newline + 1)
          const frame = JSON.parse(line) as ToHost

          if (!dropped && frame.type === 'call' && frame.operation.kind === 'input'
          && frame.operation.input.text.includes(text)) {
            requestId = frame.id
            target = frame.operation.ref.id
          }

          if (dropped && frame.type === 'call' && frame.operation.kind === 'attach'
            && frame.operation.scope.kind === 'session' && frame.operation.scope.ref.id === target) {
            attachId = frame.id
          }

          up.write(`${line}\n`)
          newline = requests.indexOf('\n')
        }
      },
    )
    up.on(
      'data',
      chunk => {
        responses += chunk
        let newline = responses.indexOf('\n')

        while (newline >= 0) {
          const line = responses.slice(
            0,
            newline,
          )
          responses = responses.slice(newline + 1)
          const frame = JSON.parse(line) as ToClient

          if (!dropped && frame.type === 'reply' && frame.id === requestId) {
            dropped = true
            close()

            return
          }

          if (holdAttach && !heldOnce && frame.type === 'reply' && frame.id === attachId) {
            heldOnce = true
            heldReply = () => down.write(`${line}\n`)
          } else {
            down.write(`${line}\n`)
          }

          newline = responses.indexOf('\n')
        }
      },
    )
  })
  await new Promise<void>((
    resolve,
    reject,
  ) => {
    server.once(
      'error',
      reject,
    )
    server.listen(
      socket,
      resolve,
    )
  })

  return {
    dropped: () => dropped,
    attached: () => !!heldReply,
    release() {
      heldReply?.()
      heldReply = undefined
    },
    async close() {
      for (const connection of connections) {
        connection.destroy()
      }

      await promisify(server.close.bind(server))()
    },
  }
}
