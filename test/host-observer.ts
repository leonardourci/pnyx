import { EventEmitter, once } from 'node:events'
import { setTimeout, clearTimeout } from 'node:timers'
import { WebSocket } from 'ws'
import { createHost as host, type QueryFn } from '../src/server/host.ts'
import { startServer as serve } from '../src/server/server.ts'
import { localToken } from '../src/server/state.ts'

const watchdog = setTimeout
const clearWatchdog = clearTimeout

export function hostObserver({ describe }: { describe(): unknown }) {
  const events = new EventEmitter()
  const sockets = new Set<WebSocket>()
  let request = 0
  const notify = () => events.emit('change')

  const query = ({ run }: { run: QueryFn }): QueryFn => (({ ...args }: Parameters<QueryFn>[0]) => {
    const result = run(args)

    return new Proxy(
      result,
      {
        // eslint-disable-next-line pnyx/object-params -- Proxy owns this signature.
        get(
          target,
          key,
        ) {
          if (key === Symbol.asyncIterator) {
            return async function* () {
              try {
                for await (const event of target) {
                  yield event
                  notify()
                }
              } finally {
                notify()
              }
            }
          }

          const value = Reflect.get(
            target,
            key,
          )

          if (typeof value !== 'function') {
            return value
          }

          // eslint-disable-next-line pnyx/object-params -- Forwards the SDK method signature.
          return (...args: unknown[]) => {
            const result = Reflect.apply(
              value,
              target,
              args,
            )
            notify()

            return result
          }
        },
      },
    )
  }) as QueryFn

  const startServer = async ({ ...options }: Parameters<typeof serve>[0]) => {
    const spawnCodex = options.spawnCodex
    const server = await serve({
      ...options,
      query: options.query && query({ run: options.query }),
      spawnCodex: spawnCodex && (({ ...args }) => {
        const child = spawnCodex(args)
        child.stdout.on(
          'data',
          () => setImmediate(notify),
        )
        child.on(
          'close',
          () => setImmediate(notify),
        )

        return child
      }),
    })
    const ws = new WebSocket(`${server.url.replace(
      'http',
      'ws',
    )}ws?token=${localToken()}`)
    ws.on(
      'message',
      notify,
    )

    try {
      await new Promise<void>((
        resolve,
        reject,
      ) => {
        ws.once(
          'open',
          resolve,
        )
        ws.once(
          'error',
          reject,
        )
      })
    } catch (error) {
      ws.terminate()
      await server.close()
      throw error
    }

    sockets.add(ws)
    let closed = false

    return {
      ...server,
      async close() {
        if (closed) {
          return
        }

        closed = true
        sockets.delete(ws)
        const socketClosed = once(
          ws,
          'close',
        )
        ws.terminate()
        await socketClosed
        await server.close()
      },
    }
  }

  const createHost = ({ ...options }: Parameters<typeof host>[0]) => host({
    ...options,
    query: options.query && query({ run: options.query }),
    changed: () => {
      options.changed()
      notify()
    },
    streamed: ({ ...args }) => {
      options.streamed?.(args)
      notify()
    },
  })

  const until = ({
    check,
    progress = () => {},
  }: {
    check(): boolean
    progress?(): void
  }) => new Promise<void>((
    resolve,
    reject,
  ) => {
    let scheduled: ReturnType<typeof setImmediate> | undefined

    const done = () => {
      clearImmediate(scheduled)
      events.off(
        'change',
        changed,
      )
      clearWatchdog(timer)
    }

    const inspect = () => {
      scheduled = undefined

      try {
        progress()

        if (check()) {
          done()
          resolve()
        }
      } catch (error) {
        done()
        reject(error)
      }
    }

    const changed = () => {
      if (!scheduled) {
        scheduled = setImmediate(inspect)
      }
    }

    const timer = watchdog(
      () => {
        done()
        reject(new Error(`No provider or durable state completion for ${check}; state: ${JSON.stringify(describe())}`))
      },
      30_000,
    )
    events.on(
      'change',
      changed,
    )
    changed()
  })

  const checkpoint = async ({ ws }: { ws?: WebSocket } = {}) => {
    const targets = ws ? [ws] : [...sockets]
    await Promise.all(targets.map(ws => new Promise<void>((
      resolve,
      reject,
    ) => {
      const id = `observer-${++request}`
      const timer = watchdog(
        () => {
          ws.off(
            'message',
            receipt,
          )
          reject(new Error(`Server did not drain ${id}; state: ${JSON.stringify(describe())}`))
        },
        30_000,
      )

      // eslint-disable-next-line pnyx/object-params -- WebSocket owns this callback signature.
      const receipt = (raw: WebSocket.RawData) => {
        const message = JSON.parse(String(raw))

        if (message.id !== id) {
          return
        }

        ws.off(
          'message',
          receipt,
        )
        clearWatchdog(timer)

        if (message.type === 'receipt') {
          resolve()
        } else {
          reject(new Error(String(raw)))
        }
      }

      ws.on(
        'message',
        receipt,
      )
      ws.send(JSON.stringify({
        type: 'command',
        id,
        name: 'history',
        args: [
          '--limit',
          '1',
        ],
      }))
    })))
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  return {
    startServer,
    createHost,
    until,
    notify,
    checkpoint,
  }
}
