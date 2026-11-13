import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HydraError } from '#store/errors.ts'
import { hydraDir } from './home-migration.ts'
import { pnyxHome, withRegistryLock, writeDurably } from '#store/storage.ts'

// A fixed default keeps every Hydra at one address, so an open tab finds a restarted server again.
export const DEFAULT_PORT = 4747
// A busy server can hold its event loop for seconds, and a message sent while it seems down never reaches it.
const HEALTH_TIMEOUT_MS = 60_000

export interface ServerInfo {
  pid: number
  port: number
  // The address of a Hydra on the server, ending in /hydra/<id>/; the record itself names the default Hydra.
  url: string
  // A Hydra's hook socket; null when it could not be bound, and hooks then spool.
  socket: string | null
  service?: boolean
  serveArgs?: string[]
}

export const infoPath = () => join(
  pnyxHome(),
  'server.json',
)
export const socketPath = ({ hydraId }: { hydraId: string }) => join(
  hydraDir({ hydraId }),
  'server.sock',
)

// The running server and the Hydras it serves. stopped: none is running, which a server.json left by a server
// that died (its pid or port since reused) also counts as; a dead pid is not asked at all.
// silent: its process is alive but /health did not answer, so what it is doing is unknown.
export async function probeServer(): Promise<{
  info: ServerInfo
  hydras: string[]
} | 'stopped' | 'silent'> {
  let info: ServerInfo

  try {
    info = JSON.parse(readFileSync(
      infoPath(),
      'utf8',
    )) as ServerInfo

    // Inside the server, the Hydras it runs are known without asking itself.
    if (info.pid === process.pid) {
      return {
        info,
        hydras: [...hosts.keys()],
      }
    }

    process.kill(
      info.pid,
      0,
    )
  } catch {
    return 'stopped'
  }

  let res: Response

  try {
    res = await fetch(
      `http://127.0.0.1:${info.port}/health`,
      {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      },
    )
  } catch (error) {
    const refused = ((error as Error).cause as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED'

    return refused ? 'stopped' : 'silent'
  }

  try {
    const health = (await res.json()) as {
      hydras?: unknown
      pid?: unknown
    }

    return health.pid === info.pid ? {
      info,
      hydras: Array.isArray(health.hydras) ? health.hydras.map(String) : [],
    } : 'stopped'
  } catch {
    // Another program answers on the recorded port.
    return 'stopped'
  }
}

// The server, with the address of this Hydra on it, or null when none answers or it does not serve this Hydra.
export async function readServer({ hydraId }: { hydraId: string }): Promise<ServerInfo | null> {
  const server = await probeServer()

  return typeof server !== 'string' && server.hydras.includes(hydraId) ? {
    ...server.info,
    url: `http://127.0.0.1:${server.info.port}/hydra/${hydraId}/`,
    socket: socketPath({ hydraId }),
  } : null
}

// Created on first use, readable only by this user. The WebSocket handshake requires it.
export function localToken(): string {
  const path = join(
    pnyxHome(),
    'token',
  )

  try {
    return readFileSync(
      path,
      'utf8',
    ).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  mkdirSync(
    pnyxHome(),
    { recursive: true },
  )

  try {
    writeFileSync(
      path,
      randomBytes(32).toString('hex'),
      {
        flag: 'wx',
        mode: 0o600,
      },
    )
  } catch (error) {
    // Another process created it first; use theirs.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  return readFileSync(
    path,
    'utf8',
  ).trim()
}

type Ask = ({ body }: { body: Record<string, unknown> }) => Promise<Record<string, unknown>>
const hosts = new Map<string, Ask>()

// The server offers each Hydra it runs; a command it runs asks that Hydra's agents through here.
export function offerHost({
  hydraId,
  ask,
}: {
  hydraId: string
  ask: Ask
}): () => void {
  hosts.set(
    hydraId,
    ask,
  )

  return () => {
    if (hosts.get(hydraId) === ask) {
      hosts.delete(hydraId)
    }
  }
}

// Acts on an agent the server runs. Throws NOT_RUNNING when this process serves no such Hydra, so nothing was sent.
export async function askHost({
  hydraId,
  body,
}: {
  hydraId: string
  body: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const ask = hosts.get(hydraId)

  if (!ask) {
    throw new HydraError({
      message: `the Pnyx server for Hydra ${hydraId} is not running`,
      code: 'NOT_RUNNING',
      help: ['Run `pnyx-axi serve`; it runs the agents Pnyx starts'],
    })
  }

  return ask({ body })
}

export function hydraIdentity({ hydraId }: { hydraId: string }): string {
  return createHash('sha256').update(localToken())
    .update(hydraId)
    .digest('hex')
    .slice(
      0,
      24,
    )
}

// The agent host of earlier builds recorded its start in local time (see stopOldHost); everything else uses UTC.
export function processStart({
  pid,
  localTime = false,
}: {
  pid: number
  localTime?: boolean
}): string | null {
  try {
    return execFileSync(
      '/bin/ps',
      [
        '-o',
        'lstart=',
        '-p',
        String(pid),
      ],
      {
        encoding: 'utf8',
        timeout: 2000,
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
        env: {
          ...process.env,
          ...localTime ? {} : { TZ: 'UTC' },
          LC_ALL: 'C',
        },
      },
    ).trim() || null
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      return null
    }

    throw error
  }
}

let startup: {
  pid: number
  processStart: string
  revision: number
} | undefined
let lastStartupWrite = 0
const STARTUP_PULSE_MS = 1000
const startupPath = () => join(
  pnyxHome(),
  'server.startup.json',
)

export function reportStartup(): void {
  if (!startup || Date.now() - lastStartupWrite < STARTUP_PULSE_MS) {
    return
  }

  startup.revision++
  writeDurably({
    path: `${startupPath()}.tmp`,
    data: Buffer.from(JSON.stringify(startup)),
    flag: 'w',
  })
  renameSync(
    `${startupPath()}.tmp`,
    startupPath(),
  )
  lastStartupWrite = Date.now()
}

export function startupRevision(): string | undefined {
  try {
    const progress = JSON.parse(readFileSync(
      startupPath(),
      'utf8',
    )) as {
      pid: number
      processStart: string
      revision: number
    }
    const claim = JSON.parse(readFileSync(
      join(
        pnyxHome(),
        'server.lock',
      ),
      'utf8',
    )) as {
      pid: number
      processStart: string
    }

    if (progress.pid === claim.pid && progress.processStart === claim.processStart
      && Number.isSafeInteger(progress.pid) && progress.pid > 0
      && processStart({ pid: progress.pid }) === progress.processStart) {
      return `${progress.pid}:${progress.processStart}:${progress.revision}`
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return undefined
}

// One server per Pnyx home; a second start while the first is alive is refused.
export function claimServer(): () => void {
  const path = join(
    pnyxHome(),
    'server.lock',
  )
  const started = processStart({ pid: process.pid })

  if (!started) {
    throw new HydraError({
      message: 'could not identify the server process',
      code: 'SERVER_UNAVAILABLE',
    })
  }

  const owner = JSON.stringify({
    pid: process.pid,
    processStart: started,
  })
  withRegistryLock({
    fn: () => {
      let previous: {
        pid?: unknown
        processStart?: unknown
      } | null = null

      try {
        previous = JSON.parse(readFileSync(
          path,
          'utf8',
        ))
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      if (typeof previous?.pid === 'number' && Number.isInteger(previous.pid) && previous.pid > 0
      && typeof previous.processStart === 'string'
      && processStart({ pid: previous.pid }) === previous.processStart) {
        throw new HydraError({
          message: 'a Pnyx server is already running for this home',
          code: 'ALREADY_RUNNING',
        })
      }

      writeFileSync(
        path,
        owner,
        { mode: 0o600 },
      )
    },
  })

  startup = {
    pid: process.pid,
    processStart: started,
    revision: 0,
  }
  lastStartupWrite = 0

  try {
    reportStartup()
  } catch (error) {
    startup = undefined
    rmSync(
      path,
      { force: true },
    )
    throw error
  }

  // A live owner cannot be replaced; releasing its claim does not write Hydra state.
  return () => {
    startup = undefined
    rmSync(
      startupPath(),
      { force: true },
    )

    if (readFileSync(
      path,
      'utf8',
    ) === owner) {
      rmSync(
        path,
        { force: true },
      )
    }
  }
}
