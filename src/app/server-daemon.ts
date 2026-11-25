import { nativeHome } from './native-home.ts'
import { trackChildren } from '#workers/children.ts'
import { finishTitanRemoval } from '#titan/remove.ts'
import { recoverOwnerCommands } from './confirmations.ts'
import { withLogRequest } from '#diagnostics/context.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { createSocketOutbox, MAX_SOCKET_BYTES } from './socket-outbox.ts'
import { createSocketHistory, type SocketCursor, type SocketFrame } from './socket-history.ts'
import { pageChanges, type HomeMessage, type HomePage, type PageChanges } from './socket-state.ts'
import type { CatalogLocations } from '#titan/transcripts-catalog.ts'
import { agentsMidTurn, type QueryFn } from './host.ts'
import type { SpawnCodex } from '#workers/codex.ts'
import type { ReminderScheduler } from '#tasks/reminder-scheduler.ts'
import { startReviewTimer } from '#titan/review-timer.ts'
import { allowedRequest, requestUrl, TITAN_PATH, type RunningServer, type MountedTitan, type TitanSubscription, type ServerMessage, type TitanClient } from './server-transport.ts'
import { MAX_MESSAGE_BYTES } from './server-protocol.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { background } from './background.ts'
import { listTitans, nameUnnamedTitans } from './server-hydras.ts'
import { reply, serveStatic, buildId, parseMessage } from './server-http.ts'
import { hydraIds, hydrasDir } from './home-migration.ts'
import { hydraRemoval, localToken, hydraIdentity, claimServer, infoPath, type ServerInfo } from './server-state.ts'
import { serviceFile } from '#setup/service.ts'
import { runForRequest } from './api-run.ts'
import { readBody } from './server-http.ts'
import { TitanError } from '#store/errors.ts'
import { CREATION_POLL_MS, RETRY_MS, UPGRADE_CHECK_MS, mountOwnedTitan } from './server.ts'
import { watchPath } from './watch.ts'
import { pageSettings, readSettings, settingsLogPath } from '#settings/store.ts'
import { privateDir, replaceFile } from '#store/storage.ts'
import { upgradeAvailable } from '#upgrade/runner.ts'
import { logPageLines } from '#diagnostics/page-lines.ts'
import { startServerLogs } from '#diagnostics/server-logs.ts'
import { flushLogs, log } from './diagnostics.ts'
import { hydraExists, loadTitan } from './store.ts'
import { repairDispatchMirrors } from '#workers/dispatch-config.ts'

// Only the named and default Titans must load; any other Titan that fails is skipped and reported.
const bearer = ({ req }: { req: IncomingMessage }) => {
  const token = Buffer.from(localToken())
  const given = Buffer.from(req.headers.authorization?.replace(
    /^Bearer /,
    '',
  ) ?? '')

  return given.length === token.length && timingSafeEqual(
    given,
    token,
  )
}

// A page's open cards as page command arguments, from its subscribe message or its socket URL.
const pageArgs = ({ value }: { value: unknown }) => Array.isArray(value) && value.every(arg => typeof arg === 'string')
  ? value
  : undefined

const parseJson = ({ text }: { text: string | null }): unknown => {
  if (text === null) {
    return undefined
  }

  try {
    return JSON.parse(text)
  } catch {
    // An unreadable value is the same as none: the page sends its cards again as a page command.
    return undefined
  }
}

export async function startServer({
  hydraId = 'default',
  port = 0,
  ...options
}: {
  hydraId?: string
  port?: number
  catalogLocations?: CatalogLocations
  // The Agent SDK's query; tests pass a fake.
  query?: QueryFn
  spawnCodex?: SpawnCodex
  // How long a hosted Titan's wake waits for more changes, a stall lasts before waking it, a tool call keeps a worker busy, a repeat stall waits at most, an open-ended worker pause lasts, a failed Titan start waits before each retry, followed pull requests wait between reads and queues wait between checks; tests shorten them.
  wakeDelay?: number
  stallDelay?: number
  busyDelay?: number
  stallRepeatMax?: number
  compactionDelay?: number
  retryDelays?: number[]
  followDelay?: number
  queueDelay?: number
  recoveryPause?: number
  // How often the process line is written; tests shorten it.
  processLineMs?: number
  reminderScheduler?: ReminderScheduler
  reviewClock?: Pick<Parameters<typeof startReviewTimer>[0], 'now' | 'interval'>
  // The Othrys folder the daily check and /upgrade read, and how /upgrade restarts the server.
  // Only serve checks the real folder, so a test server never asks GitHub.
  upgradeRoot?: string
  restart?(): void | Promise<void>
}): Promise<RunningServer> {
  const starting = performance.now()
  const releaseClaim = claimServer()
  let epoch: string

  try {
    repairDispatchMirrors()
    epoch = nativeHome().epoch
  } catch (error) {
    releaseClaim()
    throw error
  }

  const logs = startServerLogs({
    settings: readSettings().settings,
    processLineMs: options.processLineMs,
  })

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  })
  let importing = true
  const mounts = new Map<string, Promise<MountedTitan>>()
  const served = new Map<string, MountedTitan>()
  const unmountedStops = new Set<Promise<void>>()
  const pendingLogs = new Map<string, () => void>()
  const skipped: Record<string, string> = {}
  let closed = false
  let summariesQueued = false
  const homeDelta = ({ frame }: { frame: SocketFrame<PageChanges> }): HomeMessage => ({
    type: 'home.delta',
    cursor: {
      epoch: frame.epoch,
      seq: frame.seq,
    },
    changes: frame.value,
  })
  const homeHistory = createSocketHistory<PageChanges>({
    epoch,
    measure: ({ frame }) => Buffer.byteLength(JSON.stringify(homeDelta({ frame }))),
  })
  const homeClients = new Set<({ message }: { message: HomeMessage }) => void>()

  const homeSettings = (): HomePage['settings'] => {
    const {
      settings,
      revision,
    } = readSettings()

    return {
      settings: pageSettings({ settings }),
      revision,
    }
  }

  let home: HomePage = {
    hydras: [],
    settings: homeSettings(),
    upgrade: null,
    scopes: {},
  }

  let upgradeStatus: UpgradeStatus | null = null

  const publishHome = () => {
    const next: HomePage = JSON.parse(JSON.stringify({
      hydras: listTitans(),
      settings: homeSettings(),
      upgrade: upgradeStatus,
      scopes: Object.fromEntries([...served].map(([
        id,
        mount,
      ]) => [
        id,
        mount.view(),
      ])),
    }))
    const changes = pageChanges({
      before: home,
      after: next,
    })

    if (changes) {
      const frame = homeHistory.append({ value: changes })
      home = next
      const message = homeDelta({ frame })

      for (const send of homeClients) {
        send({ message })
      }
    }
  }

  const hydrasChanged = () => {
    if (closed || summariesQueued) {
      return
    }

    summariesQueued = true
    setImmediate(() => background({
      name: 'Titan summaries',
      run: () => {
        summariesQueued = false

        if (closed) {
          return
        }

        publishHome()
      },
    }))
  }

  // Clients that send no Origin are local programs, not pages; writes still need the token.
  const hosts = new Set<string>()
  const origins = new Set<string>()
  let allowedHosts = readSettings().settings.allowedHosts
  const allowed = ({ req }: { req: IncomingMessage }) => allowedRequest({
    host: req.headers.host,
    origin: req.headers.origin,
    hosts,
    origins,
    allowedHosts,
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
    ] = TITAN_PATH.exec(path) ?? []

    if (id !== undefined) {
      const mount = served.get(id)

      if (!mount) {
        if ((req.method === 'GET' || req.method === 'HEAD') && (rest === '/' || rest === '/settings/')
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
            error: `Titan not served: ${id}`,
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

    if (req.method === 'POST' && path === '/api/run') {
      if (!bearer({ req })) {
        return reply({
          res,
          status: 401,
          body: {
            error: 'missing or wrong token',
            code: 'UNAUTHORIZED',
          },
        })
      }

      return reply({
        res,
        status: 200,
        body: await runForRequest({ body: await readBody({ req }) }),
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
        // Whether an agent on any Titan is mid-turn; an upgrade run from a terminal waits for none to be.
        midTurn: agentsMidTurn(),
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

  const http = createServer(async (
    req,
    res,
  ) => {
    const started = performance.now()
    const requestId = randomUUID()
    // Paths can contain user input; retain only a known route family.
    const route = /^\/(api|health)(?:[/?]|$)/.exec(req.url ?? '')?.[1] ?? 'static'
    res.once(
      'close',
      () => log({
        operation: 'http.request',
        requestId,
        name: route,
        status: res.writableFinished ? String(res.statusCode) : 'aborted',
        ms: performance.now() - started,
        detailed: res.writableFinished && res.statusCode < 400,
      }),
    )

    try {
      await withLogRequest({
        requestId,
        response: res,
        run: () => request({
          req,
          res,
        }),
      })
    } catch (error) {
      log({
        level: 'error',
        operation: 'http.request',
        requestId,
        name: route,
        error,
      })

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
    }
  })

  http.on(
    'upgrade',
    (
      req,
      socket,
      head,
    ) => {
      // The HTTP server unhooks its own error listener on upgrade, so a client gone mid-upgrade would crash the server.
      socket.on(
        'error',
        () => socket.destroy(),
      )
      const url = requestUrl({ url: req.url })

      // ponytail: /ws, like /, is the named Titan's, for tabs from before one server and the Vite dev page.
      const requested = url.searchParams.get('scope')
      const initialScope = requested && served.has(requested) ? requested : hydraId
      const [
        , id,
        rest,
      ] = url.pathname === '/ws' ? [
        '',
        initialScope,
        '/ws',
      ] : TITAN_PATH.exec(url.pathname) ?? []
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
          const subscriptions = new Map<string, TitanSubscription>()
          const attaching = new Map<string, symbol>()
          const scoped = url.searchParams.get('scoped') === '1'
          const readsHome = url.searchParams.get('home') === '1'
          const primary = id!

          const outbox = createSocketOutbox({
            socket: {
              get bufferedAmount() {
                return ws.bufferedAmount
              },
              open: () => ws.readyState === ws.OPEN,
              send({
                text,
                message,
              }) {
                ws.send(text)
                log({
                  operation: 'socket.send',
                  detailed: true,
                  hydraId: message.scope ?? primary,
                  name: message.type,
                  bytes: Buffer.byteLength(text),
                  backlog: ws.bufferedAmount,
                })
              },
              disconnect: () => ws.terminate(),
            },
          })
          const send = ({
            message,
            snapshot,
          }: {
            message: ServerMessage
            snapshot?: boolean
          }) => outbox.send({
            message,
            snapshot,
          })

          const sendHome = ({ message }: { message: HomeMessage }) => {
            send({ message })
          }

          if (readsHome) {
            publishHome()
            const cursor = parseJson({ text: url.searchParams.get('cursor') }) as SocketCursor | undefined
            const ready: HomeMessage = {
              type: 'home.ready',
              cursor: homeHistory.cursor(),
            }
            const retained = homeHistory.since({
              cursor,
              budget: MAX_SOCKET_BYTES - Buffer.byteLength(JSON.stringify(ready)),
            })

            if (retained) {
              for (const frame of retained) {
                sendHome({ message: homeDelta({ frame }) })
              }
            } else {
              sendHome({
                message: {
                  type: 'home.snapshot',
                  cursor: homeHistory.cursor(),
                  home,
                },
              })
            }

            sendHome({ message: ready })
            homeClients.add(sendHome)
          }

          const attach = ({
            hydra,
            mounted,
            page,
            subscriptionId,
          }: {
            hydra: string
            mounted: MountedTitan
            page?: string[]
            subscriptionId?: string
          }) => {
            const client: TitanClient = {
              get bufferedAmount() {
                return ws.bufferedAmount
              },
              get readyState() {
                return ws.readyState
              },
              OPEN: ws.OPEN,
              send({
                message,
                snapshot,
              }) {
                return send({
                  snapshot,
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
              page,
            })
            subscriptions.set(
              hydra,
              subscription,
            )
          }

          const subscribe = async ({
            hydra,
            page,
            subscriptionId,
          }: {
            hydra: string
            page?: string[]
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
                  page,
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
                    code: error instanceof TitanError ? error.code : 'UNKNOWN',
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
              homeClients.delete(sendHome)
              outbox.close()
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

              if (message?.type === 'log') {
                logPageLines({ value: message.lines })

                return
              }

              const hydra = message?.scope === undefined ? primary : message.scope

              if (typeof hydra !== 'string' || !/^[a-z0-9._-]+$/.test(hydra)) {
                send({
                  message: {
                    type: 'error',
                    id: typeof message?.id === 'string' ? message.id : null,
                    error: 'Invalid Titan scope',
                    code: 'VALIDATION_ERROR',
                  },
                })

                return
              }

              if (message?.type === 'subscribe') {
                void subscribe({
                  hydra,
                  page: pageArgs({ value: message.page }),
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
                      error: 'Subscribe to this Titan before sending commands',
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
            page: pageArgs({ value: parseJson({ text: url.searchParams.get('page') }) }),
            subscriptionId: url.searchParams.get('subscription') ?? undefined,
          })
        },
      )
    },
  )

  try {
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
  } catch (error) {
    logs.close()
    releaseClaim()
    throw error
  }

  const bound = (http.address() as { port: number }).port
  const serverUrl = `http://127.0.0.1:${bound}/`

  for (const host of [
    `127.0.0.1:${bound}`,
    `localhost:${bound}`,
  ]) {
    hosts.add(host)
    origins.add(`http://${host}`)
  }

  // A folder can appear before its Titan's first write commits; the Titan is served once it has.
  const watchMissingLog = ({ id }: { id: string }) => {
    if (closed || pendingLogs.has(id)) {
      return
    }

    const stop = () => {
      clearInterval(timer)
      pendingLogs.delete(id)
    }

    const ready = () => background({
      name: 'Titan discovery',
      run: () => {
        if (closed || !hydraExists({ hydraId: id })) {
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
    const timer = setInterval(
      ready,
      CREATION_POLL_MS,
    )
    timer.unref()
    ready()
  }

  const removalPending = ({ id }: { id: string }) =>
    hydraExists({ hydraId: id }) && loadTitan({ hydraId: id }).state.config?.removing === true

  const mount = async ({ id }: { id: string }): Promise<MountedTitan> => {
    if (removalPending({ id })) {
      throw new TitanError({
        message: `Titan removal is pending: ${id}`,
        code: 'CONFLICT',
      })
    }

    const known = mounts.get(id)

    if (known) {
      return known
    }

    if (closed) {
      throw new TitanError({
        message: 'the server is stopping',
        code: 'NOT_RUNNING',
      })
    }

    const opening = performance.now()
    const started = mountTitan({
      hydraId: id,
      url: `http://127.0.0.1:${bound}/hydra/${id}/`,
      open,
      hydrasChanged,
      ...options,
    })
    mounts.set(
      id,
      started,
    )
    started.then(
      m => {
        // Loading the Titan from its rows and starting its host, the start-up cost that grows with a Titan.
        log({
          operation: 'hydra.open',
          hydraId: id,
          ms: performance.now() - opening,
        })
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

        if (error instanceof TitanError && error.code === 'NOT_FOUND') {
          watchMissingLog({ id })
        }
      },
    )

    return started
  }

  async function open({ id }: { id: string }): Promise<string> {
    if (!hydraIds().includes(id)) {
      throw new TitanError({
        message: `Titan not found: ${id}`,
        code: 'NOT_FOUND',
      })
    }

    return (await mount({ id })).url
  }

  hydraRemoval.close = async ({ hydraId }) => {
    served.delete(hydraId)
    const mounted = mounts.get(hydraId)

    if (mounted) {
      const openTitan = await mounted
      served.delete(hydraId)
      await openTitan.close({ permanent: true })
    } else {
      const stopping = trackChildren({ hydraId }).stopAll()
      unmountedStops.add(stopping)

      try {
        await stopping
      } finally {
        unmountedStops.delete(stopping)
      }
    }
  }

  hydraRemoval.finished = ({ hydraId: removedId }) => {
    served.delete(removedId)
    mounts.delete(removedId)

    if (importing) {
      return
    }

    const activeIds = hydraIds()

    const primaryUnavailable = !activeIds.includes(removedId) || removalPending({ id: removedId })

    if (hydraId === removedId && primaryUnavailable) {
      hydraId = activeIds.find(id => !removalPending({ id })) ?? hydraId
    }

    mountAll()
    hydrasChanged()
  }

  let named: MountedTitan

  const recordSkippedTitan = ({
    id,
    error,
    before,
  }: {
    id: string
    error: unknown
    before?: string
  }) => {
    const reason = error instanceof Error ? error.message : String(error)
    skipped[id] = reason

    if (reason !== before) {
      log({
        level: 'warn',
        operation: 'hydra.skipped',
        hydraId: id,
        error,
      })
    }
  }

  const mountDiscoveredTitan = async ({ id }: { id: string }) => {
    const before = skipped[id]

    try {
      if (!removalPending({ id })) {
        await mount({ id })
      }
    } catch (error) {
      recordSkippedTitan({
        id,
        error,
        before,
      })
    }
  }

  const mountAll = () => {
    if (importing) {
      return
    }

    for (const id of hydraIds()) {
      if (closed || mounts.has(id)) {
        continue
      }

      void mountDiscoveredTitan({ id })
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
  const settingsDir = dirname(settingsLogPath())
  privateDir({ dir: settingsDir })
  let appliedRevision = readSettings().revision

  const syncSettings = () => {
    const {
      revision,
      settings,
    } = readSettings()

    if (closed) {
      return
    }

    if (revision !== appliedRevision) {
      appliedRevision = revision
      allowedHosts = settings.allowedHosts
      logs.apply({ settings })
      served.forEach(m => m.settings())
    }

    publishHome()
  }

  const settingsWatcher = watchPath({
    path: settingsDir,
    changed: syncSettings,
    interval: CREATION_POLL_MS,
  })
  const retry = setInterval(
    () => {
      background({
        name: 'mount Titans',
        run: mountAll,
      })
      background({
        name: 'settings refresh',
        run: syncSettings,
      })
    },
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
      publishHome()
    },
  })
  let upgradeTimer: NodeJS.Timeout | undefined

  const close = async () => {
    const stopping = performance.now()
    closed = true
    hydraRemoval.close = undefined
    hydraRemoval.finished = undefined
    watcher.close()
    settingsWatcher.close()
    clearInterval(retry)
    clearInterval(upgradeTimer)
    pendingLogs.forEach(stop => stop())

    try {
      await Promise.allSettled(unmountedStops)
      const settled = await Promise.allSettled([...mounts].map(async ([
        id,
        mounting,
      ]) => ({
        id,
        mounted: await mounting,
      })))
      const open = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])

      // Every Titan finishes its cleanup before the claim goes, even when one of them fails.
      await Promise.all(open.map(async ({
        id,
        mounted,
      }) => {
        try {
          await mounted.close()
        } catch (error) {
          log({
            level: 'error',
            operation: 'hydra.close',
            hydraId: id,
            error,
          })
        }
      }))
    } finally {
      for (const ws of wss.clients) {
        ws.terminate()
      }

      wss.close()
      http.closeAllConnections()
      await new Promise(r => http.close(r))
      rmSync(
        infoPath(),
        { force: true },
      )
      log({
        operation: 'server.stop',
        ms: performance.now() - stopping,
      })
      await flushLogs()
      logs.close()
      releaseClaim()
    }
  }

  try {
    for (const id of hydraIds()) {
      try {
        if (removalPending({ id })) {
          await finishTitanRemoval({ id })
        }
      } catch (error) {
        log({
          level: 'error',
          operation: 'hydra.remove',
          hydraId: id,
          error,
        })
      }
    }

    for (const id of hydraIds()) {
      try {
        await recoverOwnerCommands({ hydraId: id })
      } catch (error) {
        log({
          level: 'warn',
          operation: 'approval.recover',
          hydraId: id,
          error,
        })
      }
    }

    const removedOrPending = ({ id }: { id: string }) => {
      if (!hydraExists({ hydraId: id })) {
        return false
      }

      const config = loadTitan({ hydraId: id }).state.config

      return config?.removed === true || config?.removing === true
    }

    if (removedOrPending({ id: hydraId })) {
      const activeId = hydraIds().find(id => {
        try {
          return !removedOrPending({ id })
        } catch (error) {
          recordSkippedTitan({
            id,
            error,
            before: skipped[id],
          })

          return false
        }
      })

      if (!activeId) {
        throw new TitanError({
          message: 'No active Titan is available',
          code: 'NOT_FOUND',
        })
      }

      hydraId = activeId
    }

    named = await mount({ id: hydraId })

    if (!removedOrPending({ id: 'default' })) {
      await mount({ id: 'default' })
    }

    for (const id of hydraIds()) {
      if (!mounts.has(id)) {
        await mountDiscoveredTitan({ id })
      }
    }

    importing = false
    checkUpgrade()
    upgradeTimer = setInterval(
      checkUpgrade,
      UPGRADE_CHECK_MS,
    ).unref()

    replaceFile({
      path: infoPath(),
      text: JSON.stringify({
        pid: process.pid,
        port: bound,
        url: serverUrl,
        socket: named.socket,
        service: process.env.OTHRYS_SERVICE_ROLE === 'application'
          || process.env.XPC_SERVICE_NAME === serviceFile().label,
        serveArgs: process.argv[2] === 'serve' ? process.argv.slice(3) : undefined,
      } satisfies ServerInfo),
    })
  } catch (error) {
    await close()
    throw error
  }

  log({
    operation: 'server.start',
    // Other lines leave the process id out; this one says which process the lines after it come from.
    pid: process.pid,
    ms: performance.now() - starting,
  })

  background({
    name: 'name Titans',
    run: nameUnnamedTitans,
  })

  return {
    port: bound,
    url: serverUrl,
    socket: named.socket,
    skipped: { ...skipped },
    open,
    close,
  }
}

async function mountTitan({
  hydraId,
  url,
  catalogLocations,
  query,
  spawnCodex,
  wakeDelay,
  stallDelay,
  busyDelay,
  stallRepeatMax,
  compactionDelay,
  retryDelays,
  followDelay,
  queueDelay,
  recoveryPause,
  reviewClock,
  reminderScheduler,
  open,
  hydrasChanged,
  upgradeRoot,
  restart,
}: {
  hydraId: string
  url: string
  catalogLocations?: CatalogLocations
  query?: QueryFn
  spawnCodex?: SpawnCodex
  wakeDelay?: number
  stallDelay?: number
  busyDelay?: number
  stallRepeatMax?: number
  compactionDelay?: number
  retryDelays?: number[]
  followDelay?: number
  queueDelay?: number
  recoveryPause?: number
  reminderScheduler?: ReminderScheduler
  reviewClock?: Pick<Parameters<typeof startReviewTimer>[0], 'now' | 'interval'>
  open({ id }: { id: string }): Promise<string>
  hydrasChanged(): void
  upgradeRoot?: string
  restart?(): void | Promise<void>
}): Promise<MountedTitan> {
  return mountOwnedTitan({
    hydraId,
    url,
    catalogLocations,
    query,
    spawnCodex,
    wakeDelay,
    stallDelay,
    busyDelay,
    stallRepeatMax,
    compactionDelay,
    retryDelays,
    followDelay,
    queueDelay,
    recoveryPause,
    reviewClock,
    reminderScheduler,
    open,
    hydrasChanged,
    upgradeRoot,
    restart,
  })
}
