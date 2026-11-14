import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import type { CatalogLocations } from '#hydra/transcripts-catalog.ts'
import { agentsMidTurn, type QueryFn } from './host.ts'
import type { SpawnCodex } from '#workers/codex.ts'
import type { ReminderScheduler } from '#tasks/reminder-scheduler.ts'
import { startReviewTimer } from '#hydra/review-timer.ts'
import { allowedRequest, requestUrl, HYDRA_PATH, ZERO_QUERY_PATH, type RunningServer, type MountedHydra, type HydraSubscription, type ServerMessage, type HydraClient } from './server-transport.ts'
import { MAX_MESSAGE_BYTES, zeroCookieName } from './server-protocol.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { background } from './background.ts'
import { listHydras, nameUnnamedHydras } from './server-hydras.ts'
import { reply, serveStatic, buildId, parseMessage } from './server-http.ts'
import { hydraIds, hydrasDir } from './home-migration.ts'
import { localToken, hydraIdentity, claimServer, infoPath, type ServerInfo } from './server-state.ts'
import { serviceFile } from '#setup/service.ts'
import { runForRequest } from './api-run.ts'
import { readBody } from './server-http.ts'
import { HydraError } from '#store/errors.ts'
import { CREATION_POLL_MS, RETRY_MS, UPGRADE_CHECK_MS, mountOwnedHydra } from './server.ts'
import { watchPath } from './watch.ts'
import { mirrorSettings, readSettings, settingsLogPath } from '#settings/store.ts'
import { privateDir, replaceFile } from '#store/storage.ts'
import { upgradeAvailable } from '#upgrade/runner.ts'
import { logPageLines } from '#diagnostics/page-lines.ts'
import { startServerLogs } from '#diagnostics/server-logs.ts'
import { flushLogs, log } from './diagnostics.ts'
import { isZeroPath, startZeroCache, type ZeroCache } from './zero-cache.ts'
import { hydraExists } from './store.ts'
import { query } from '#store/postgres.ts'

// Only the named and default Hydras must load; any other Hydra that fails is skipped and reported.
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

// The last upgrade check, the row the page's upgrade notice reads.
const saveUpgradeStatus = ({ status }: { status: UpgradeStatus }) => query({
  statements: [
    {
      text: `insert into upgrade_status (id, available, checked_at) values ('current', $1, $2)
        on conflict (id) do update set available = excluded.available, checked_at = excluded.checked_at`,
      values: [
        status.available,
        status.checkedAt,
      ],
    },
  ],
})

export async function startServer({
  hydraId = 'default',
  port = 0,
  homes,
  zeroCache = false,
  ...options
}: {
  hydraId?: string
  port?: number
  homes?: string[]
  // Whether to run zero-cache for the page's reads; only serve does, so other test servers start no child.
  zeroCache?: boolean
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
  recoveryPause?: number
  // How often the process line is written; tests shorten it.
  processLineMs?: number
  reminderScheduler?: ReminderScheduler
  reviewClock?: Pick<Parameters<typeof startReviewTimer>[0], 'now' | 'interval'>
  // The Pnyx folder the daily check and /upgrade read, and how /upgrade restarts the server.
  // Only serve checks the real folder, so a test server never asks GitHub.
  upgradeRoot?: string
  restart?(): void | Promise<void>
}): Promise<RunningServer> {
  const starting = performance.now()
  const releaseClaim = claimServer()
  const logs = startServerLogs({
    settings: readSettings().settings,
    processLineMs: options.processLineMs,
  })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  })
  let importing = true
  const mounts = new Map<string, Promise<MountedHydra>>()
  const served = new Map<string, MountedHydra>()
  const pendingLogs = new Map<string, () => void>()
  const skipped: Record<string, string> = {}
  let closed = false
  let summariesQueued = false, summariesKey = ''
  let zero: ZeroCache | undefined

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

        // The page reads the Hydra list through Zero; a summary that changes without an event, as a Firstmate home's
        // projects can, is written to its row here.
        if (key !== summariesKey) {
          query({
            statements: hydras.map(summary => ({
              text: 'update hydras set summary = $2::json where id = $1 and summary::text is distinct from $2::text',
              values: [
                summary.id,
                JSON.stringify(summary),
              ],
            })),
          })
          // Only once written, so a failed write is tried again on the next change.
          summariesKey = key
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

    if (isZeroPath({ path })) {
      return zero ? zero.request({
        req,
        res,
      }) : reply({
        res,
        status: 404,
        body: {
          error: 'this server runs no zero-cache',
          code: 'NOT_FOUND',
        },
      })
    }

    // Outside /zero, so a page cannot reach it through the proxy; zero-cache calls it with its per-run API key.
    if (req.method === 'POST' && path === ZERO_QUERY_PATH && zero) {
      return zero.query({
        req,
        res,
        search,
      })
    }

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
              cookie: zeroCookieName({ port: bound }),
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

    // A pnyx-axi command line from a client; the CLI sends every command but the few that must work while the server is down.
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
        // Whether an agent on any Hydra is mid-turn; an upgrade run from a terminal waits for none to be.
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

  const http = createServer((
    req,
    res,
  ) => {
    void request({
      req,
      res,
    }).catch(error => {
      log({
        level: 'error',
        operation: 'http.request',
        name: `${req.method} ${req.url?.split('?')[0] ?? '/'}`,
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

      if (isZeroPath({ path: url.pathname })) {
        if (!zero || !allowed({ req })) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')

          return
        }

        return zero.upgrade({
          req,
          socket,
          head,
        })
      }

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
            if (ws.readyState !== ws.OPEN) {
              return
            }

            const started = performance.now()
            // Encoded here, as ws would, so the line has the bytes sent; it still goes as a text frame.
            const data = Buffer.from(JSON.stringify(message))
            ws.send(
              data,
              { binary: false },
            )
            log({
              operation: 'socket.send',
              // Every message is a live update; a thread page also gets its own thread.page line.
              detailed: true,
              hydraId: message.scope ?? primary,
              name: message.type,
              bytes: data.length,
              backlog: ws.bufferedAmount,
              ms: performance.now() - started,
            })
          }

          const attach = ({
            hydra,
            mounted,
            page,
            subscriptionId,
          }: {
            hydra: string
            mounted: MountedHydra
            page?: string[]
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
                    error: 'Invalid Hydra scope',
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

  for (const host of [
    `127.0.0.1:${bound}`,
    `localhost:${bound}`,
  ]) {
    hosts.add(host)
    origins.add(`http://${host}`)
  }

  // A folder can appear before its Hydra's first write commits; the Hydra is served once it has.
  const watchMissingLog = ({ id }: { id: string }) => {
    if (closed || pendingLogs.has(id)) {
      return
    }

    const stop = () => {
      clearInterval(timer)
      pendingLogs.delete(id)
    }

    const ready = () => background({
      name: 'Hydra discovery',
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

    const opening = performance.now()
    const started = mountHydra({
      hydraId: id,
      url: `http://127.0.0.1:${bound}/hydra/${id}/`,
      homes: id === hydraId ? homes : undefined,
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
        // Loading the Hydra from its rows and starting its host, the start-up cost that grows with a Hydra.
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
    if (importing) {
      return
    }

    for (const id of hydraIds()) {
      const before = skipped[id]

      if (!closed && !mounts.has(id)) {
        mount({ id }).catch((error: Error) => {
          if (error.message !== before) {
            log({
              level: 'warn',
              operation: 'hydra.skipped',
              hydraId: id,
              error,
            })
          }
        })
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
  // The settings log is written by any pnyx-axi process; every open page gets the change.
  const settingsDir = dirname(settingsLogPath())
  privateDir({ dir: settingsDir })
  // The revision the server runs with, and the one Postgres holds for the pages from the first mount on. A change
  // applies at once; a mirror that failed is tried again on the next change or retry.
  let appliedRevision = readSettings().revision
  let mirroredRevision: number | undefined

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
      logs.apply({ settings })
      served.forEach(m => m.settings())
    }

    if (mirroredRevision !== undefined && revision !== mirroredRevision) {
      mirrorSettings({
        settings,
        revision,
      })
      mirroredRevision = revision
    }
  }

  const settingsWatcher = watchPath({
    path: settingsDir,
    changed: syncSettings,
    interval: CREATION_POLL_MS,
  })
  const retry = setInterval(
    () => {
      background({
        name: 'mount Hydras',
        run: mountAll,
      })
      background({
        name: 'settings mirror',
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

      saveUpgradeStatus({
        status: {
          available,
          checkedAt: new Date().toISOString(),
        },
      })
    },
  })
  let upgradeTimer: NodeJS.Timeout | undefined

  const close = async () => {
    const stopping = performance.now()
    closed = true
    watcher.close()
    settingsWatcher.close()
    clearInterval(retry)
    clearInterval(upgradeTimer)
    pendingLogs.forEach(stop => stop())

    try {
      const settled = await Promise.allSettled([...mounts].map(async ([
        id,
        mounting,
      ]) => ({
        id,
        mounted: await mounting,
      })))
      const open = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])

      // Every Hydra finishes its cleanup before the claim goes, even when one of them fails.
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
      // zero-cache first: it ends the page sockets it tunnels, which the HTTP server cannot close itself.
      await zero?.close()
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

  // Everything from here reads Postgres, so a Postgres that is down or misconfigured stops the start and releases the
  // claim, instead of leaving a server that holds it without serving.
  try {
    named = await mount({ id: hydraId })
    await mount({ id: 'default' })

    for (const id of hydraIds()) {
      try {
        await mount({ id })
      } catch (error) {
        log({
          level: 'warn',
          operation: 'hydra.skipped',
          hydraId: id,
          error: error as Error,
        })
      }
    }

    importing = false
    const startSettings = readSettings()
    mirrorSettings(startSettings)
    mirroredRevision = startSettings.revision
    // A check made before this start may describe the build it replaced, so the notice waits for this build's own.
    query({ statements: [{ text: 'delete from upgrade_status' }] })
    checkUpgrade()
    upgradeTimer = setInterval(
      checkUpgrade,
      UPGRADE_CHECK_MS,
    ).unref()

    // All legacy imports finish before Zero starts building its first replica.
    if (zeroCache) {
      zero = startZeroCache({
        queryUrl: `http://127.0.0.1:${bound}${ZERO_QUERY_PATH}`,
        token: localToken(),
        cookie: zeroCookieName({ port: bound }),
      })
    }

    replaceFile({
      path: infoPath(),
      text: JSON.stringify({
        pid: process.pid,
        port: bound,
        url: named.url,
        socket: named.socket,
        service: process.env.PNYX_SERVICE_ROLE === 'application'
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
    name: 'name Hydras',
    run: nameUnnamedHydras,
  })

  return {
    port: bound,
    url: named.url,
    socket: named.socket,
    skipped: { ...skipped },
    open,
    zeroCachePid: () => zero?.pid(),
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
  recoveryPause?: number
  reminderScheduler?: ReminderScheduler
  reviewClock?: Pick<Parameters<typeof startReviewTimer>[0], 'now' | 'interval'>
  open({ id }: { id: string }): Promise<string>
  hydrasChanged(): void
  upgradeRoot?: string
  restart?(): void | Promise<void>
}): Promise<MountedHydra> {
  return mountOwnedHydra({
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
    recoveryPause,
    reviewClock,
    reminderScheduler,
    open,
    hydrasChanged,
    upgradeRoot,
    restart,
  })
}
