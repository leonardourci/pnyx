import { fork, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { handleQueryRequest } from '@rocicorp/zero/server'
import { mustGetQuery, type ReadonlyJSONValue } from '@rocicorp/zero'
import { configuredUrl, homeDatabase } from '#store/postgres.ts'
import { pnyxHome, privateDir } from '#store/storage.ts'
import { queries, schema } from '#store/zero-schema.ts'
import { log } from './diagnostics.ts'
import { readBody, reply } from './server-http.ts'
import { STOP_TIMEOUT_MS, ZERO_OWNER, ZERO_PATH } from './server-transport.ts'

// The zero-cache binary's own entry, run with this Node rather than through the shell shim in node_modules/.bin.
const ZERO_CLI = fileURLToPath(new URL(
  './cli.js',
  import.meta.resolve('@rocicorp/zero'),
))
const SECRET_BYTES = 32
// Created by src/store/schema.sql.
const PAGE_PUBLICATION = 'pnyx_page'
const DEFAULT_PG_PORT = '5432'
// A child that stays ready this long has recovered, so its next exit starts the restart delays over.
const STABLE_MS = 60_000
// Waits before each restart after an unexpected exit; past the last one every restart waits as long as the last, so a
// Postgres that comes back, or another home that took a slot, never leaves the page without sync for good.
const RESTART_DELAYS_MS = [
  1_000,
  5_000,
  30_000,
]

const secret = () => randomBytes(SECRET_BYTES).toString('hex')

const sameSecret = ({
  given,
  expected,
}: {
  given: string | undefined
  expected: string
}) => {
  const bytes = Buffer.from(given ?? '')
  const wanted = Buffer.from(expected)

  return wanted.length > 0 && bytes.length === wanted.length && timingSafeEqual(
    bytes,
    wanted,
  )
}

const cookie = ({
  header,
  name,
}: {
  header: string | undefined
  name: string
}) => header?.split(';').map(part => part.trim())
  .find(part => part.startsWith(`${name}=`))
  ?.slice(name.length + 1)

export const isZeroPath = ({ path }: { path: string }) => path === ZERO_PATH || path.startsWith(`${ZERO_PATH}/`)

const zeroTarget = ({ url = '/' }: { url?: string }) => {
  const rest = url.slice(ZERO_PATH.length)

  return rest.startsWith('/') ? rest : `/${rest}`
}

// The postgresUrl setting, or host, port and user from the same PG* variables and defaults as the server's own connection.
function upstreamUrl(): string {
  const configured = configuredUrl()

  if (configured) {
    return configured
  }

  const host = process.env.PGHOST || 'localhost'
  const port = process.env.PGPORT || DEFAULT_PG_PORT
  const user = encodeURIComponent(process.env.PGUSER || userInfo().username)
  const database = homeDatabase()

  // A URL cannot name a socket folder, so zero-cache's postgres.js reads PGHOST and the rest from the inherited env.
  if (host.startsWith('/')) {
    return `postgresql:///${database}`
  }

  return `postgresql://${user}@${host}:${port}/${database}`
}

// Both probes stay open until both have a port, so the two never get the same one.
async function freePorts({ count }: { count: number }): Promise<number[]> {
  const probes = await Promise.all(Array.from(
    { length: count },
    () => new Promise<Server>((
      resolve,
      reject,
    ) => {
      const probe = createServer()
      probe.once(
        'error',
        reject,
      )
      probe.listen(
        0,
        '127.0.0.1',
        () => resolve(probe),
      )
    }),
  ))
  const ports = probes.map(probe => (probe.address() as AddressInfo).port)
  await Promise.all(probes.map(probe => new Promise(resolve => probe.close(resolve))))

  return ports
}

export interface ZeroCache {
  pid(): number | undefined
  request({
    req,
    res,
  }: {
    req: IncomingMessage
    res: ServerResponse
  }): void
  upgrade({
    req,
    socket,
    head,
  }: {
    req: IncomingMessage
    socket: Duplex
    head: Buffer
  }): void
  query({
    req,
    res,
    search,
  }: {
    req: IncomingMessage
    res: ServerResponse
    search: string
  }): Promise<void>
  close(): Promise<void>
}

export function startZeroCache({
  queryUrl,
  token,
  cookie: cookieName,
}: {
  // The server's query endpoint, which zero-cache calls with the per-run API key.
  queryUrl: string
  token: string
  // The cookie the page's HTML sets with the token.
  cookie: string
}): ZeroCache {
  const dir = join(
    pnyxHome(),
    'zero',
  )
  privateDir({ dir })
  const apiKey = secret()
  let child: ChildProcess | undefined
  // Set once the running child reported ready, so the proxy never forwards to a port nobody listens on yet.
  let port: number | undefined
  let stopping = false
  let restarts = 0
  let restartTimer: NodeJS.Timeout | undefined
  let stableTimer: NodeJS.Timeout | undefined
  // The page sockets this server tunnels to zero-cache, both ends.
  const tunnels = new Set<Duplex>()

  const forwardOutput = ({ stream }: { stream: NodeJS.ReadableStream | null }) => {
    if (!stream) {
      return
    }

    createInterface({ input: stream }).on(
      'line',
      line => {
        // Named queries enforce reads; this cache exposes no client mutations or upstream permission rules.
        const permissionsAdvice = line.includes('No upstream permissions deployed.')
          || line.includes("Run 'npx zero-deploy-permissions")

        if (!line.trim() || permissionsAdvice) {
          return
        }

        log({
          level: 'warn',
          operation: 'zero.output',
          name: line,
        })
      },
    )
  }

  const exited = ({
    code,
    signal,
  }: {
    code: number | null
    signal: NodeJS.Signals | null
  }) => {
    child = undefined
    port = undefined
    clearTimeout(stableTimer)

    if (stopping) {
      return
    }

    const delay = RESTART_DELAYS_MS[Math.min(
      restarts,
      RESTART_DELAYS_MS.length - 1,
    )]

    log({
      level: 'warn',
      operation: 'zero.exit',
      exitCode: code ?? undefined,
      status: signal ?? undefined,
      count: restarts + 1,
    })
    restarts += 1
    restartTimer = setTimeout(
      launch,
      delay,
    )
  }

  const run = async () => {
    const [
      syncPort,
      changeStreamerPort,
    ] = await freePorts({ count: 2 })

    if (stopping) {
      return
    }

    // zero-cache exits when the IPC channel closes, even if the server is killed; detached keeps Ctrl-C to the server.
    const started = fork(
      ZERO_CLI,
      [],
      {
        cwd: dir,
        detached: true,
        execArgv: [],
        stdio: [
          'ignore',
          'pipe',
          'pipe',
          'ipc',
        ],
        env: {
          ...process.env,
          ZERO_UPSTREAM_DB: upstreamUrl(),
          ZERO_REPLICA_FILE: join(
            dir,
            'replica.db',
          ),
          // Zero matches slots with LIKE appId_%; fixed-length alphanumeric ids keep homes' patterns disjoint.
          ZERO_APP_ID: `p${createHash('sha256').update(homeDatabase())
            .digest('hex')
            .slice(
              0,
              32,
            )}`,
          // Only the page's tables, so sessions, plan receipts and card_private never reach the replica.
          ZERO_APP_PUBLICATIONS: PAGE_PUBLICATION,
          ZERO_PORT: String(syncPort),
          ZERO_CHANGE_STREAMER_PORT: String(changeStreamerPort),
          ZERO_ADMIN_PASSWORD: secret(),
          ZERO_ENABLE_CRUD_MUTATIONS: 'false',
          ZERO_ENABLE_TELEMETRY: 'false',
          ZERO_NUM_SYNC_WORKERS: '1',
          ZERO_QUERY_URL: queryUrl,
          ZERO_QUERY_API_KEY: apiKey,
          ZERO_QUERY_FORWARD_COOKIES: 'true',
          ZERO_LOG_LEVEL: 'warn',
          // Lag reports delay readiness by about 10 s, for lag a local replica of a small database never has.
          ZERO_REPLICATION_LAG_REPORT_INTERVAL_MS: '0',
        },
      },
    )
    child = started
    forwardOutput({ stream: started.stdout })
    forwardOutput({ stream: started.stderr })
    started.on(
      'message',
      message => {
        if (Array.isArray(message) && message[0] === 'ready') {
          port = syncPort
          stableTimer = setTimeout(
            () => {
              restarts = 0
            },
            STABLE_MS,
          )
          stableTimer.unref()
        }
      },
    )
    let ended = false

    // A child that never spawned reports only an error, so either event ends this run once.
    const end = ({
      code,
      signal,
    }: {
      code: number | null
      signal: NodeJS.Signals | null
    }) => {
      if (ended) {
        return
      }

      ended = true
      exited({
        code,
        signal,
      })
    }

    started.on(
      'error',
      error => {
        log({
          level: 'error',
          operation: 'zero.start',
          error,
        })

        if (started.pid === undefined) {
          end({
            code: null,
            signal: null,
          })
        }
      },
    )
    started.once(
      'exit',
      (
        code,
        signal,
      ) => end({
        code,
        signal,
      }),
    )
  }

  function launch() {
    run().catch((error: unknown) => log({
      level: 'error',
      operation: 'zero.start',
      error,
    }))
  }

  launch()

  const authorized = ({ req }: { req: IncomingMessage }) => sameSecret({
    given: cookie({
      header: req.headers.cookie,
      name: cookieName,
    }),
    expected: token,
  })

  return {
    pid: () => child?.pid,
    request({
      req,
      res,
    }) {
      if (!authorized({ req })) {
        return reply({
          res,
          status: 401,
          body: {
            error: 'missing or wrong token cookie',
            code: 'UNAUTHORIZED',
          },
        })
      }

      if (port === undefined) {
        return reply({
          res,
          status: 503,
          body: {
            error: 'zero-cache is starting',
            code: 'NOT_RUNNING',
          },
        })
      }

      const upstream = http.request(
        {
          host: '127.0.0.1',
          port,
          method: req.method,
          path: zeroTarget({ url: req.url }),
          headers: req.headers,
        },
        answer => {
          res.writeHead(
            answer.statusCode ?? 502,
            answer.headers,
          )
          answer.pipe(res)
        },
      )
      upstream.on(
        'error',
        () => {
          if (res.headersSent) {
            res.destroy()

            return
          }

          reply({
            res,
            status: 502,
            body: {
              error: 'zero-cache did not answer',
              code: 'NOT_RUNNING',
            },
          })
        },
      )
      req.pipe(upstream)
    },
    upgrade({
      req,
      socket,
      head,
    }) {
      if (!authorized({ req })) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')

        return
      }

      if (port === undefined) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')

        return
      }

      const upstream = connect(
        {
          host: '127.0.0.1',
          port,
        },
        () => {
          const lines = []

          // The cookie stays, as zero-cache hands it to the query endpoint, which checks it.
          for (let index = 0; index < req.rawHeaders.length; index += 2) {
            lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`)
          }

          upstream.write(`${req.method} ${zeroTarget({ url: req.url })} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
          upstream.write(head)
          upstream.pipe(socket)
          socket.pipe(upstream)
        },
      )
      upstream.on(
        'error',
        () => socket.destroy(),
      )
      socket.on(
        'error',
        () => upstream.destroy(),
      )

      for (const end of [
        socket,
        upstream,
      ]) {
        tunnels.add(end)
        end.once(
          'close',
          () => tunnels.delete(end),
        )
      }
    },
    async query({
      req,
      res,
      search,
    }) {
      const key = req.headers['x-api-key']
      // A repeated header arrives as a list, which is never the one key.
      const fromZeroCache = sameSecret({
        given: typeof key === 'string' ? key : undefined,
        expected: apiKey,
      })

      // The page's token cookie, which zero-cache forwards from the page's socket, proves the query came through /zero.
      if (!fromZeroCache || !authorized({ req })) {
        return reply({
          res,
          status: 401,
          body: {
            error: 'missing or wrong API key or token cookie',
            code: 'UNAUTHORIZED',
          },
        })
      }

      const answer = await handleQueryRequest({
        // eslint-disable-next-line pnyx/object-params -- Zero owns the query handler's signature.
        handler: (
          name: string,
          args: ReadonlyJSONValue | undefined,
        ) => mustGetQuery(
          queries,
          name,
        ).fn({
          args,
          ctx: undefined,
        }),
        schema,
        userID: ZERO_OWNER,
        query: new URLSearchParams(search),
        body: await readBody({ req }) as ReadonlyJSONValue,
      })
      reply({
        res,
        status: 200,
        body: answer,
      })
    },
    async close() {
      stopping = true
      clearTimeout(restartTimer)

      // An upgraded page socket is outside the HTTP server's connections, so it would keep that server from closing.
      for (const end of tunnels) {
        end.destroy()
      }

      clearTimeout(stableTimer)
      const running = child
      const pid = running?.pid
      const ended = running?.exitCode !== null || running.signalCode !== null

      if (pid === undefined || ended) {
        return
      }

      const gone = new Promise(resolve => running.once(
        'exit',
        resolve,
      ))

      // zero-cache leads its own process group, so its workers stop with it; a group already gone needs nothing.
      const signal = ({ name }: { name: NodeJS.Signals }) => {
        try {
          process.kill(
            -pid,
            name,
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error
          }
        }
      }

      signal({ name: 'SIGTERM' })
      const killTimer = setTimeout(
        () => signal({ name: 'SIGKILL' }),
        STOP_TIMEOUT_MS,
      )
      await gone
      clearTimeout(killTimer)
    },
  }
}
