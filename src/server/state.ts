import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HydraError } from '../core/model.ts'
import { hydraDir, pnyxHome, withWriter } from '../store/hydra-store.ts'

export const DEFAULT_PORT = 4747
// A busy server can hold its event loop for seconds, and a message sent while it seems down never reaches it.
const HEALTH_TIMEOUT_MS = 60_000

export interface ServerInfo {
  pid: number
  port: number
  // The Hydra's address on the one server, ending in /hydra/<id>/.
  url: string
  // Null when the ingest socket could not be bound; hooks then spool.
  socket: string | null
}

// Only the path of the recorded address is used, so a request (and the token sent with it) never leaves this machine.
const local = ({
  info,
  path,
}: {
  info: ServerInfo
  path: string
}) => {
  const url = new URL(
    path,
    `http://127.0.0.1:${info.port}${new URL(info.url).pathname}`,
  )

  if (url.host !== `127.0.0.1:${info.port}`) {
    throw new HydraError({
      message: 'the recorded server address is not local',
      code: 'SERVER_UNAVAILABLE',
    })
  }

  return url
}

export const infoPath = ({ hydraId }: { hydraId: string }) => join(
  hydraDir({ hydraId }),
  'server.json',
)
export const socketPath = ({ hydraId }: { hydraId: string }) => join(
  hydraDir({ hydraId }),
  'server.sock',
)

// The Hydra's server, or null when none is running. Trusted only when the
// recorded port answers /health with this Hydra and pid, so a server.json left
// by a server that died (its pid or port since reused) counts as not running.
// A dead pid is not asked at all, so only a running server is waited on.
export async function readServer({ hydraId }: { hydraId: string }): Promise<ServerInfo | null> {
  let info: ServerInfo

  try {
    info = JSON.parse(readFileSync(
      infoPath({ hydraId }),
      'utf8',
    )) as ServerInfo
    process.kill(
      info.pid,
      0,
    )
    const res = await fetch(
      local({
        info,
        path: 'health',
      }),
      { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) },
    )
    const health = (await res.json()) as {
      hydraId?: unknown
      pid?: unknown
    }

    return health.hydraId === hydraId && health.pid === info.pid ? info : null
  } catch {
    return null
  }
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

// A start waits for the harness to open its session, which Codex allows five minutes.
const HOST_TIMEOUT_MS = 360_000

// Asks the Hydra's running server to act on an agent it hosts. Throws NOT_RUNNING when
// no server answers, so nothing was sent; any other failure after the request left may
// or may not have reached the agent.
export async function askHost({
  hydraId,
  body,
}: {
  hydraId: string
  body: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const info = await readServer({ hydraId })

  if (!info) {
    throw new HydraError({
      message: `the Pnyx server for Hydra ${hydraId} is not running`,
      code: 'NOT_RUNNING',
      help: ['Run `pnyx-axi serve`; it runs the agents Pnyx starts'],
    })
  }

  const res = await fetch(
    local({
      info,
      path: 'host',
    }),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${localToken()}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    },
  )
  type Answer = Record<string, unknown> & {
    error?: string
    code?: string
    help?: string[]
  }
  const answer = (await res.json()) as Answer

  if (!res.ok) {
    throw new HydraError({
      message: answer.error ?? `the server answered ${res.status}`,
      code: answer.code ?? 'UNKNOWN',
      help: answer.help ?? [],
    })
  }

  return answer
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

function processStart({ pid }: { pid: number }): string | null {
  try {
    return execFileSync(
      'ps',
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
          TZ: 'UTC',
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

export function claimServer({ hydraId }: { hydraId: string }): () => void {
  const path = join(
    hydraDir({ hydraId }),
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
  withWriter({
    hydraId,
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
          message: `a server already owns Hydra ${hydraId}`,
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

  // A live owner cannot be replaced; releasing its claim does not write Hydra state.
  return () => {
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
