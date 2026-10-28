import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { unwatchFile, existsSync, watchFile, mkdirSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import type { CatalogLocations } from '../thread/catalog.ts'
import type { QueryFn } from './host.ts'
import type { SpawnCodex } from '../workers/codex.ts'
import type { ReminderScheduler } from '../tasks/reminder-scheduler.ts'
import { startReviewTimer } from '../review/timer.ts'
import { allowedRequest, requestUrl, HYDRA_PATH, type RunningServer, type MountedHydra, type HydraSubscription, type ServerMessage, type HydraClient } from './server-transport.ts'
import { MAX_MESSAGE_BYTES } from './server-protocol.ts'
import type { UpgradeStatus } from '../upgrade/model.ts'
import { background } from './background.ts'
import { listHydras } from './server-hydras.ts'
import { reply, serveStatic, buildId, parseMessage } from './server-http.ts'
import { hydraIds, hydraDir, hydrasDir } from './home-migration.ts'
import { localToken, hydraIdentity, claimServer } from './server-state.ts'
import { HydraError } from '../store/errors.ts'
import { CREATION_POLL_MS, RETRY_MS, UPGRADE_CHECK_MS, mountOwnedHydra } from './server.ts'
import { watchPath } from './watch.ts'
import { upgradeAvailable } from '../upgrade/runner.ts'

// Only the named and default Hydras must load; any other Hydra that fails is skipped and reported.
export async function startServer({
  hydraId = 'default',
  port = 0,
  homes,
  ...options
}: {
  hydraId?: string
  port?: number
  homes?: string[]
  catalogLocations?: CatalogLocations
  // The Agent SDK's query; tests pass a fake.
  query?: QueryFn
  spawnCodex?: SpawnCodex
  // How long a hosted Hydra's wake waits for more changes, a stall lasts before waking it, a tool call keeps a worker busy, a repeat stall waits at most, an open-ended worker pause lasts, a failed Hydra start waits before each retry and followed pull requests wait between reads; tests shorten them.
  wakeDelay?: number
  stallDelay?: number
  busyDelay?: number
  stallRepeatMax?: number
  pauseDelay?: number
  retryDelays?: number[]
  followDelay?: number
  reminderScheduler?: ReminderScheduler
  reviewClock?: Pick<Parameters<typeof startReviewTimer>[0], 'now' | 'interval'>
  // The Pnyx folder the daily check and /upgrade read, and how /upgrade restarts the server.
  // Only serve checks the real folder, so a test server never asks GitHub.
  upgradeRoot?: string
  restart?(): void
}): Promise<RunningServer> {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  })
  const mounts = new Map<string, Promise<MountedHydra>>()
  const served = new Map<string, MountedHydra>()
  const pendingLogs = new Map<string, () => void>()
  const skipped: Record<string, string> = {}
  let closed = false
  let summariesQueued = false, summariesKey = ''
  let upgradeStatus: UpgradeStatus | undefined

  const hydrasChanged = () => {
    if (closed || summariesQueued) {
      return
    }

    summariesQueued = true
    setImmediate(() => background({
      name: 'Hydra summaries',
      run: () => {
        summariesQueued = false

        if (closed) {
          return
        }

        const hydras = listHydras(), key = JSON.stringify(hydras)

        if (key !== summariesKey) {
          summariesKey = key
          served.forEach(m => m.summaries({ hydras }))
        }
      },
    }))
  }

  // Clients that send no Origin are local programs, not pages; writes still need the token.
  const hosts = new Set<string>()
  const origins = new Set<string>()
  const allowed = ({ req }: { req: IncomingMessage }) => allowedRequest({
    host: req.headers.host,
    origin: req.headers.origin,
    hosts,
    origins,
  })

  const request = async ({
    req,
    res,
  }: {
    req: IncomingMessage
    res: ServerResponse
  }): Promise<void> => {
    if (!allowed({ req })) {
      return reply({
        res,
        status: 403,
        body: {
          error: 'origin or host not allowed',
          code: 'FORBIDDEN',
        },
      })
    }

    const {
      pathname: path,
      search,
    } = requestUrl({ url: req.url })
    const [
      , id,
      rest,
    ] = HYDRA_PATH.exec(path) ?? []

    if (id !== undefined) {
      const mount = served.get(id)

      if (!mount) {
        if ((req.method === 'GET' || req.method === 'HEAD') && rest === '/'
          && hydraIds().includes(id)) {
          return serveStatic({
            res,
            path: '/',
            home: `/hydra/${id}/`,
            page: {
              token: localToken(),
              identity: hydraIdentity({ hydraId: id }),
              base: `/hydra/${id}/`,
            },
          })
        }

        return reply({
          res,
          status: 404,
          body: {
            error: `Hydra not served: ${id}`,
            code: 'NOT_FOUND',
            ...(skipped[id] ? { reason: skipped[id] } : {}),
          },
        })
      }

      if (rest === undefined) {
        return void res.writeHead(
          308,
          { location: `/hydra/${id}/` },
        ).end()
      }

      return mount.request({
        req,
        res,
        path: rest,
        search,
      })
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply({
        res,
        status: 405,
        body: {
          error: 'method not allowed',
          code: 'METHOD_NOT_ALLOWED',
        },
      })
    }

    if (path === '/health') {
      const hydras = [...served.keys()].sort()
      const body = {
        pid: process.pid,
        build: buildId(),
        hydras,
        skipped,
      }

      return reply({
        res,
        status: 200,
        body,
      })
    }

    const home = `/hydra/${hydraId}/${search}`

    if (path === '/') {
      return void res.writeHead(
        302,
        { location: home },
      ).end()
    }

    serveStatic({
      res,
      path,
      home,
    })
  }

  const http = createServer((
    req,
    res,
  ) => {
    void request({
      req,
      res,
    }).catch(error => {
      console.error(
        `pnyx-axi request: ${req.method} ${req.url?.split('?')[0] ?? '/'}`,
        error,
      )

      if (res.destroyed || res.writableEnded) {
        return
      }

      if (res.headersSent) {
        res.destroy()

        return
      }

      try {
        reply({
          res,
          status: 500,
          body: {
            error: 'request failed',
            code: 'INTERNAL_ERROR',
          },
        })
      } catch {
        res.destroy()
      }
    })
  })

  http.on(
    'upgrade',
    (
      req,
      socket,
      head,
    ) => {
      const url = requestUrl({ url: req.url })
      // ponytail: /ws, like /, is the named Hydra's, for tabs from before one server and the Vite dev page.
      const requested = url.searchParams.get('scope')
      const initialScope = requested && served.has(requested) ? requested : hydraId
      const [
        , id,
        rest,
      ] = url.pathname === '/ws' ? [
        '',
        initialScope,
        '/ws',
      ] : HYDRA_PATH.exec(url.pathname) ?? []
      const mount = id === undefined ? undefined : served.get(id)

      if (!mount || rest !== '/ws' || !allowed({ req })) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')

        return
      }

      const token = Buffer.from(localToken())
      const given = Buffer.from(url.searchParams.get('token') ?? '')

      if (given.length !== token.length || !timingSafeEqual(
        given,
        token,
      )) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')

        return
      }

      wss.handleUpgrade(
        req,
        socket,
        head,
        ws => {
          const subscriptions = new Map<string, HydraSubscription>()
          const attaching = new Map<string, symbol>()
          const scoped = url.searchParams.get('scoped') === '1'
          const primary = id!

          const send = ({ message }: { message: ServerMessage }) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(message))
            }
          }

          const attach = ({
            hydra,
            mounted,
            after,
            subscriptionId,
          }: {
            hydra: string
            mounted: MountedHydra
            after: string | null
            subscriptionId?: string
          }) => {
            const client: HydraClient = {
              get bufferedAmount() {
                return ws.bufferedAmount
              },
              get readyState() {
                return ws.readyState
              },
              OPEN: ws.OPEN,
              send({ message }) {
                send({
                  message: scoped || hydra !== primary ? {
                    ...message,
                    scope: hydra,
                    subscription: subscriptionId,
                  } : message,
                })
              },
              terminate() {
                ws.terminate()
              },
            }
            const subscription = mounted.connect({
              ws: client,
              after,
            })
            subscriptions.set(
              hydra,
              subscription,
            )
          }

          const subscribe = async ({
            hydra,
            after,
            subscriptionId,
          }: {
            hydra: string
            after: string | null
            subscriptionId?: string
          }) => {
            subscriptions.get(hydra)?.close()
            subscriptions.delete(hydra)
            const generation = Symbol()
            attaching.set(
              hydra,
              generation,
            )

            try {
              await open({ id: hydra })

              if (attaching.get(hydra) === generation && ws.readyState === ws.OPEN) {
                attaching.delete(hydra)
                attach({
                  hydra,
                  mounted: served.get(hydra)!,
                  after,
                  subscriptionId,
                })
              }
            } catch (error) {
              if (attaching.get(hydra) === generation && ws.readyState === ws.OPEN) {
                attaching.delete(hydra)
                send({
                  message: {
                    type: 'scope-error',
                    scope: hydra,
                    subscription: subscriptionId,
                    error: (error as Error).message,
                    code: error instanceof HydraError ? error.code : 'UNKNOWN',
                  },
                })
              }
            }
          }

          ws.on(
            'error',
            () => ws.close(),
          )
          ws.on(
            'close',
            () => {
              attaching.clear()
              subscriptions.forEach(subscription => subscription.close())
              subscriptions.clear()
            },
          )
          ws.on(
            'message',
            data => {
              const message = parseMessage({ text: data.toString() })

              if (message?.type === 'ping') {
                send({ message: { type: 'pong' } })

                return
              }

              const hydra = message?.scope === undefined ? primary : message.scope

              if (typeof hydra !== 'string' || !/^[a-z0-9._-]+$/.test(hydra)) {
                send({
                  message: {
                    type: 'error',
                    id: typeof message?.id === 'string' ? message.id : null,
                    error: 'Invalid Hydra scope',
                    code: 'VALIDATION_ERROR',
                  },
                })

                return
              }

              if (message?.type === 'subscribe') {
                void subscribe({
                  hydra,
                  after: typeof message.after === 'string' ? message.after : null,
                  subscriptionId: typeof message.subscription === 'string' ? message.subscription : undefined,
                })
              } else if (message?.type === 'unsubscribe') {
                attaching.delete(hydra)
                subscriptions.get(hydra)?.close()
                subscriptions.delete(hydra)
              } else {
                const subscription = subscriptions.get(hydra)

                if (subscription) {
                  subscription.receive({ message })
                } else {
                  send({
                    message: {
                      type: 'error',
                      scope: hydra,
                      id: typeof message?.id === 'string' ? message.id : null,
                      error: 'Subscribe to this Hydra before sending commands',
                      code: 'NOT_RUNNING',
                    },
                  })
                }
              }
            },
          )
          attach({
            hydra: primary,
            mounted: mount,
            after: url.searchParams.get('after'),
            subscriptionId: url.searchParams.get('subscription') ?? undefined,
          })
        },
      )
    },
  )

  await new Promise<void>((
    resolve,
    reject,
  ) => {
    http.once(
      'error',
      reject,
    )
    http.listen(
      port,
      '127.0.0.1',
      () => resolve(),
    )
  })
  const bound = (http.address() as { port: number }).port

  for (const host of [
    `127.0.0.1:${bound}`,
    `localhost:${bound}`,
  ]) {
    hosts.add(host)
    origins.add(`http://${host}`)
  }

  // A directory notification can precede its log, and later filesystem notifications may be lost.
  const watchMissingLog = ({ id }: { id: string }) => {
    if (closed || pendingLogs.has(id)) {
      return
    }

    const path = join(
      hydraDir({ hydraId: id }),
      'events.jsonl',
    )

    const stop = () => {
      unwatchFile(
        path,
        ready,
      )
      pendingLogs.delete(id)
    }

    const ready = () => background({
      name: 'Hydra log discovery',
      run: () => {
        if (closed || !existsSync(path)) {
          return
        }

        stop()
        mountAll()
      },
    })

    pendingLogs.set(
      id,
      stop,
    )
    watchFile(
      path,
      {
        interval: CREATION_POLL_MS,
        persistent: false,
      },
      ready,
    )
    ready()
  }

  const mount = ({ id }: { id: string }): Promise<MountedHydra> => {
    const known = mounts.get(id)

    if (known) {
      return known
    }

    if (closed) {
      return Promise.reject(new HydraError({
        message: 'the server is stopping',
        code: 'NOT_RUNNING',
      }))
    }

    const started = mountHydra({
      hydraId: id,
      url: `http://127.0.0.1:${bound}/hydra/${id}/`,
      homes: id === hydraId ? homes : undefined,
      open,
      hydrasChanged,
      upgradeStatus: () => upgradeStatus,
      ...options,
    })
    mounts.set(
      id,
      started,
    )
    started.then(
      m => {
        pendingLogs.get(id)?.()

        if (closed) {
          void m.close()
        } else {
          served.set(
            id,
            m,
          )
          delete skipped[id]
          hydrasChanged()
        }
      },
      (error: Error) => {
        mounts.delete(id)
        skipped[id] = error.message

        if (error instanceof HydraError && error.code === 'NOT_FOUND') {
          watchMissingLog({ id })
        }
      },
    )

    return started
  }

  async function open({ id }: { id: string }): Promise<string> {
    if (!hydraIds().includes(id)) {
      throw new HydraError({
        message: `Hydra not found: ${id}`,
        code: 'NOT_FOUND',
      })
    }

    return (await mount({ id })).url
  }

  let named: MountedHydra

  // An older server may let go of a skipped Hydra, so it is retried; its reason is logged once.
  const mountAll = () => {
    for (const id of hydraIds()) {
      const before = skipped[id]

      if (!closed && !mounts.has(id)) {
        mount({ id }).catch((error: Error) => error.message !== before && console.error(`pnyx-axi serve: skipped Hydra ${id}: ${error.message}`))
      }
    }
  }

  const hydras = hydrasDir()
  mkdirSync(
    hydras,
    { recursive: true },
  )
  const watcher = watchPath({
    path: hydras,
    changed: mountAll,
    interval: CREATION_POLL_MS,
  })
  const retry = setInterval(
    () => background({
      name: 'mount Hydras',
      run: mountAll,
    }),
    RETRY_MS,
  ).unref()
  // Once at start, then daily: an offline check leaves the last answer, and no answer shows no hint.
  const checkUpgrade = () => options.upgradeRoot && background({
    name: 'upgrade check',
    run: async () => {
      const available = await upgradeAvailable({ root: options.upgradeRoot })

      if (closed || available === undefined) {
        return
      }

      upgradeStatus = {
        available,
        checkedAt: new Date().toISOString(),
      }
      served.forEach(m => m.upgrade())
    },
  })
  checkUpgrade()
  const upgradeTimer = setInterval(
    checkUpgrade,
    UPGRADE_CHECK_MS,
  ).unref()

  const close = async () => {
    closed = true
    watcher.close()
    clearInterval(retry)
    clearInterval(upgradeTimer)
    pendingLogs.forEach(stop => stop())

    try {
      const all = await Promise.allSettled(mounts.values())
      await Promise.all(all.flatMap(m => m.status === 'fulfilled' ? [m.value.close()] : []))
    } finally {
      for (const ws of wss.clients) {
        ws.terminate()
      }

      wss.close()
      http.closeAllConnections()
      await new Promise(r => http.close(r))
    }
  }

  try {
    named = await mount({ id: hydraId })
    await mount({ id: 'default' })
  } catch (error) {
    await close()
    throw error
  }

  await Promise.allSettled(hydraIds().map(id => mount({ id })))

  return {
    port: bound,
    url: named.url,
    socket: named.socket,
    skipped: { ...skipped },
    open,
    close,
  }
}

async function mountHydra({
  hydraId,
  url,
  homes,
  catalogLocations,
  query,
  spawnCodex,
  wakeDelay,
  stallDelay,
  busyDelay,
  stallRepeatMax,
  pauseDelay,
  retryDelays,
  followDelay,
  reviewClock,
  reminderScheduler,
  open,
  hydrasChanged,
  upgradeRoot,
  restart,
  upgradeStatus,
}: {
  hydraId: string
  url: string
  // Firstmate homes for replies; without them, the Hydra's recorded home, which is also watched.
  homes?: string[]
  catalogLocations?: CatalogLocations
  query?: QueryFn
  spawnCodex?: SpawnCodex
  wakeDelay?: number
  stallDelay?: number
  busyDelay?: number
  stallRepeatMax?: number
  pauseDelay?: number
  retryDelays?: number[]
  followDelay?: number
  reminderScheduler?: ReminderScheduler
  reviewClock?: Pick<Parameters<typeof startReviewTimer>[0], 'now' | 'interval'>
  open({ id }: { id: string }): Promise<string>
  hydrasChanged(): void
  upgradeRoot?: string
  restart?(): void
  upgradeStatus(): UpgradeStatus | undefined
}): Promise<MountedHydra> {
  const release = claimServer({ hydraId })

  try {
    return await mountOwnedHydra({
      hydraId,
      url,
      homes,
      catalogLocations,
      query,
      spawnCodex,
      wakeDelay,
      stallDelay,
      busyDelay,
      stallRepeatMax,
      pauseDelay,
      retryDelays,
      followDelay,
      reviewClock,
      reminderScheduler,
      open,
      release,
      hydrasChanged,
      upgradeRoot,
      restart,
      upgradeStatus,
    })
  } catch (error) {
    release()
    throw error
  }
}
