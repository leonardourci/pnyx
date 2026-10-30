import { createConnection, createServer, type Socket } from 'node:net'
import { chmodSync, renameSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import type { ToClient, ToHost } from '#agent-host/protocol.ts'

const MAX_TIMINGS = 10000
export type CallTiming = {
  id: string
  operation: string
  ms: number
}

export async function socketMetrics({ path }: { path: string }) {
  const upstream = `${path}.measured`
  renameSync(
    path,
    upstream,
  )
  const connections = new Set<Socket>()
  const timings: CallTiming[] = []
  let closing: Promise<void> | undefined
  const server = createServer(down => {
    const up = createConnection(upstream)
    connections.add(up)
    connections.add(down)
    up.setEncoding('utf8')
    down.setEncoding('utf8')
    let requests = '', responses = ''
    const pending = new Map<string, {
      operation: string
      started: number
    }>()

    const close = () => {
      up.destroy()
      down.destroy()
      connections.delete(up)
      connections.delete(down)
    }

    up.on(
      'error',
      close,
    )
    down.on(
      'error',
      close,
    )
    up.on(
      'close',
      close,
    )
    down.on(
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

          if ('id' in frame) {
            pending.set(
              frame.id,
              {
                operation: frame.type === 'call' ? frame.operation.kind : frame.type,
                started: performance.now(),
              },
            )
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
          const request = frame.type === 'reply' ? pending.get(frame.id) : undefined

          if (request && frame.type === 'reply') {
            if (timings.length >= MAX_TIMINGS) {
              throw new Error('Native timing fixture exceeded its sample limit')
            }

            timings.push({
              id: frame.id,
              operation: request.operation,
              ms: performance.now() - request.started,
            })
            pending.delete(frame.id)
          }

          down.write(`${line}\n`)
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
      path,
      resolve,
    )
  })
  chmodSync(
    path,
    0o600,
  )

  return {
    read: () => timings,
    close() {
      if (closing) {
        return closing
      }

      for (const connection of connections) {
        connection.destroy()
      }

      closing = promisify(server.close.bind(server))()

      return closing
    },
  }
}
