import { deferred } from './deferred.ts'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { Operation, Result, SessionRef, ToClient, ToHost } from './protocol.ts'
import { MAX_FRAME_BYTES, PROTOCOL, fail } from './protocol.ts'

const REQUEST_MS = 30000

export async function connectHost({
  socket: path,
  installation,
  token,
  capabilities = [],
}: {
  socket: string
  installation: string
  token: string
  capabilities?: string[]
}) {
  const socket = createConnection(path)
  socket.setEncoding('utf8')
  const ready = deferred<Extract<ToClient, { type: 'ready' }>>()
  const requests = new Map<string, ReturnType<typeof deferred<Result>>>()
  const subscribers = new Set<({ frame }: { frame: ToClient }) => void>()
  let buffered = '', authenticated = false
  const handshakeTimer = setTimeout(
    () => {
      ready.reject(new Error('The native host handshake timed out'))
      socket.destroy()
    },
    REQUEST_MS,
  )

  const send = ({ frame }: { frame: ToHost }) => {
    if (socket.destroyed) {
      fail({
        code: 'DISCONNECTED',
        message: 'The native host connection ended',
      })
    }

    socket.write(`${JSON.stringify(frame)}\n`)
  }

  socket.once(
    'connect',
    () => send({
      frame: {
        type: 'hello',
        protocol: PROTOCOL,
        installation,
        token,
        capabilities,
      },
    }),
  )
  socket.on(
    'data',
    chunk => {
      buffered += chunk

      if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
        socket.destroy(new Error('The native host frame limit was exceeded'))

        return
      }

      let newline = buffered.indexOf('\n')

      while (newline >= 0) {
        const line = buffered.slice(
          0,
          newline,
        )
        buffered = buffered.slice(newline + 1)
        let frame: ToClient

        try {
          frame = JSON.parse(line)
        } catch {
          socket.destroy(new Error('The native host sent invalid JSON'))

          return
        }

        if (frame.type === 'ready') {
          const compatible = frame.protocol === PROTOCOL
            && capabilities.every(required => frame.capabilities?.includes(required))

          if (!compatible) {
            ready.reject(new Error('The native host does not support the negotiated protocol or capabilities'))
            socket.destroy()

            return
          }

          clearTimeout(handshakeTimer)
          authenticated = true
          ready.resolve(frame)
        } else if (frame.type === 'error' && !authenticated) {
          ready.reject(new Error(`${frame.code}: ${frame.message}`))
          socket.destroy()
        } else if (frame.type === 'reply') {
          requests.get(frame.id)?.resolve(frame.result)
        }

        for (const subscriber of subscribers) {
          subscriber({ frame })
        }

        newline = buffered.indexOf('\n')
      }
    },
  )

  const failed = ({ error }: { error: Error }) => {
    ready.reject(error)

    for (const request of requests.values()) {
      request.reject(error)
    }
  }

  socket.on(
    'error',
    error => failed({ error }),
  )
  socket.on(
    'close',
    () => {
      clearTimeout(handshakeTimer)
      failed({ error: new Error('The native host connection ended; reconcile named requests before retry') })
    },
  )
  let inventory: Extract<ToClient, { type: 'ready' }>

  try {
    inventory = await ready.promise
  } catch (error) {
    clearTimeout(handshakeTimer)
    socket.destroy()
    throw error
  }

  const request = async ({ frame }: {
    frame: Extract<ToHost, { id: string }>
  }): Promise<Result> => {
    if (requests.has(frame.id)) {
      fail({
        code: 'REQUEST_IN_FLIGHT',
        message: 'This correlation ID is already waiting on this connection',
      })
    }

    const result = deferred<Result>()
    requests.set(
      frame.id,
      result,
    )
    const timeout = setTimeout(
      () => result.reject(new Error('The native host request timed out; look it up by ID')),
      REQUEST_MS,
    )

    try {
      send({ frame })

      return await result.promise
    } finally {
      clearTimeout(timeout)
      requests.delete(frame.id)
    }
  }

  return {
    ready: inventory,
    call: ({
      id,
      operation,
    }: {
      id: string
      operation: Operation
    }) => request({
      frame: {
        type: 'call',
        id,
        operation,
      },
    }),
    result: ({ requestId }: { requestId: string }) => request({
      frame: {
        type: 'result',
        id: randomUUID(),
        requestId,
      },
    }),
    acknowledge: ({
      ref,
      controller,
      through,
    }: {
      ref: SessionRef
      controller: string
      through: number
    }) =>
      request({
        frame: {
          type: 'ack',
          id: randomUUID(),
          ref,
          controller,
          appliedFactsThrough: through,
        },
      }),
    watch({
      ref,
      after,
    }: {
      ref: SessionRef
      after?: number
    }) {
      send({
        frame: {
          type: 'watch',
          ref,
          after,
        },
      })
    },
    subscribe({ receive }: { receive({ frame }: { frame: ToClient }): void }) {
      subscribers.add(receive)

      return () => subscribers.delete(receive)
    },
    detach() {
      socket.destroy()
    },
  }
}

export type HostClient = Awaited<ReturnType<typeof connectHost>>
