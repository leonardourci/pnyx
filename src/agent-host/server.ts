import { createServer, type Socket } from 'node:net'
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { claimHost } from './discovery.ts'
import { kernelBootIdentity } from './boot.ts'
import { hostSessions } from './sessions.ts'
import type { Provider } from '#workers/provider.ts'
import type { ProviderId, ToClient } from './protocol.ts'
import { CAPABILITIES, MAX_FRAME_BYTES, MAX_SOCKET_BYTES, PROTOCOL, errorResult, fail } from './protocol.ts'
import type { OutputLimits } from './output.ts'
import { deferred } from './deferred.ts'
import { readFrame } from './validation.ts'

const HANDSHAKE_MS = 5000
const digest = ({ value }: { value: string }) => createHash('sha256').update(value)
  .digest()

export async function serveAgentHost({
  directory,
  installation,
  build,
  providers,
  limits,
  controlTimeout,
  bootIdentity = kernelBootIdentity,
}: {
  directory: string
  installation: string
  build: string
  providers: Record<ProviderId, Provider>
  limits?: OutputLimits
  controlTimeout?: number
  bootIdentity?(): string | undefined
}) {
  const claim = claimHost({
    directory,
    installation,
    bootIdentity,
  })
  let sessions: Awaited<ReturnType<typeof hostSessions>>
  const peers = new Map<string, ({ frame }: { frame: ToClient }) => boolean>()
  let statusQueued = false, statusKey = ''

  const changed = () => {
    if (statusQueued) {
      return
    }

    statusQueued = true
    setImmediate(() => {
      statusQueued = false
      const status = sessions.maintenance()
      const key = JSON.stringify(status)

      if (key === statusKey) {
        return
      }

      statusKey = key

      for (const send of peers.values()) {
        send({
          frame: {
            type: 'host-status',
            status,
          },
        })
      }
    })
  }

  try {
    sessions = await hostSessions({
      directory,
      providers,
      build,
      limits,
      controlTimeout,
      boot: claim.boot,
      changed,
    })
  } catch (error) {
    claim.release()
    throw error
  }

  const closed = deferred<void>()
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let authenticated = false, buffered = ''
    const watches = new Map<string, () => void>()

    const send = ({ frame }: { frame: ToClient }): boolean => {
      const wire = `${JSON.stringify(frame)}\n`

      if (Buffer.byteLength(wire) > MAX_FRAME_BYTES) {
        socket.end(`${JSON.stringify({
          type: 'error',
          code: 'OUTPUT_TOO_LARGE',
          message: 'Native output exceeds the transport frame limit; retained facts require reconciliation',
        })}\n`)

        return false
      }

      if (socket.destroyed || socket.writableLength + Buffer.byteLength(wire) > MAX_SOCKET_BYTES) {
        socket.destroy()

        return false
      }

      socket.write(wire)

      return true
    }

    const peer = {
      id: randomUUID(),
      send,
    }
    const timeout = setTimeout(
      () => socket.destroy(),
      HANDSHAKE_MS,
    ).unref()

    const receive = async ({ text }: { text: string }) => {
      const frame = readFrame({ text })

      if (!authenticated) {
        if (frame.type !== 'hello' || frame.protocol !== PROTOCOL) {
          fail({
            code: 'PROTOCOL_MISMATCH',
            message: 'A supported protocol handshake is required',
          })
        }

        const authorized = frame.installation === installation
          && timingSafeEqual(
            digest({ value: frame.token }),
            digest({ value: claim.token }),
          )

        if (!authorized) {
          fail({
            code: 'AUTH_FAILED',
            message: 'The installation or native host token does not match',
          })
        }

        if (frame.capabilities?.some(capability => !CAPABILITIES.includes(capability))) {
          fail({
            code: 'CAPABILITY_MISMATCH',
            message: 'The requested native host capability is unavailable',
          })
        }

        authenticated = true
        peers.set(
          peer.id,
          send,
        )
        clearTimeout(timeout)
        send({ frame: sessions.ready() })

        return
      }

      if (frame.type === 'hello') {
        fail({
          code: 'INVALID_FRAME',
          message: 'This connection is already authenticated',
        })
      }

      if (frame.type === 'watch') {
        watches.get(frame.ref.id)?.()
        watches.set(
          frame.ref.id,
          sessions.watch({
            peer,
            ref: frame.ref,
            after: frame.after,
          }),
        )

        return
      }

      let result

      try {
        if (frame.type === 'call') {
          result = await sessions.call({
            peer,
            id: frame.id,
            operation: frame.operation,
          })
        } else if (frame.type === 'ack') {
          result = await sessions.acknowledge({
            peer,
            frame,
          })
        } else {
          result = sessions.result({ id: frame.requestId })
        }
      } catch (error) {
        result = errorResult({ error })
      }

      if (result.kind === 'shutdown') {
        const wire = `${JSON.stringify({
          type: 'reply',
          id: frame.id,
          result,
        })}\n`
        socket.write(
          wire,
          () => {
            closing = close()
            closing.catch(() => {
              process.exitCode = 1
            })
          },
        )
      } else {
        send({
          frame: {
            type: 'reply',
            id: frame.id,
            result,
          },
        })
      }
    }

    socket.on(
      'data',
      chunk => {
        buffered += chunk

        if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
          send({
            frame: {
              type: 'error',
              code: 'FRAME_TOO_LARGE',
              message: 'The native host frame limit was exceeded',
            },
          })
          socket.end()

          return
        }

        let newline = buffered.indexOf('\n')

        while (newline >= 0) {
          const text = buffered.slice(
            0,
            newline,
          )
          buffered = buffered.slice(newline + 1)
          receive({ text }).catch(error => {
            const result = errorResult({ error })
            send({
              frame: {
                type: 'error',
                code: result.code,
                message: result.message,
              },
            })

            if (!authenticated) {
              socket.end()
            }
          })
          newline = buffered.indexOf('\n')
        }
      },
    )
    socket.on(
      'error',
      () => {
        // A connection failure leaves native sessions and pending permissions open.
        socket.destroy()
      },
    )
    socket.on(
      'close',
      () => {
        clearTimeout(timeout)

        for (const unsubscribe of watches.values()) {
          unsubscribe()
        }

        peers.delete(peer.id)
        sessions.detach({ peer })
        sockets.delete(socket)
      },
    )
  })

  try {
    await claim.prepareSocket()
    await new Promise<void>((
      resolve,
      reject,
    ) => {
      server.once(
        'error',
        reject,
      )
      server.listen(
        claim.socket,
        () => {
          server.removeListener(
            'error',
            reject,
          )
          claim.bound()
          chmodSync(
            claim.socket,
            0o600,
          )
          resolve()
        },
      )
    })
  } catch (error) {
    await sessions.close()
    claim.release()
    throw error
  }

  let closing: Promise<void> | undefined

  const close = async () => {
    try {
      await sessions.close()
    } finally {
      for (const socket of sockets) {
        socket.destroy()
      }

      await new Promise<void>(resolve => server.close(() => resolve()))
      claim.release()
      closed.resolve()
    }
  }

  return {
    socket: claim.socket,
    closed: closed.promise,
    close() {
      if (!closing) {
        closing = close()
      }

      return closing
    },
  }
}
