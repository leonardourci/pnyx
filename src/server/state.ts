import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardError } from '../core/model.ts'
import { boardDir, pnyxHome, withWriter } from '../store/board-store.ts'

export const DEFAULT_PORT = 4747
const HEALTH_TIMEOUT_MS = 1000

export interface ServerInfo {
  pid: number
  port: number
  url: string
  // Null when the ingest socket could not be bound; hooks then spool.
  socket: string | null
}

export const infoPath = ({ board }: { board: string }) => join(boardDir({ board }), 'server.json')
export const socketPath = ({ board }: { board: string }) => join(boardDir({ board }), 'server.sock')

// The board's server, or null when none is running. Trusted only when the
// recorded port answers /health with this board and pid, so a server.json left
// by a server that died (its pid or port since reused) counts as not running.
export async function readServer({ board }: { board: string }): Promise<ServerInfo | null> {
  let info: ServerInfo

  try {
    info = JSON.parse(readFileSync(infoPath({ board }), 'utf8')) as ServerInfo
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    const health = (await res.json()) as { board?: unknown; pid?: unknown }

    return health.board === board && health.pid === info.pid ? info : null
  } catch {
    return null
  }
}

// Created on first use, readable only by this user. The WebSocket handshake requires it.
export function localToken(): string {
  const path = join(pnyxHome(), 'token')

  try {
    return readFileSync(path, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  mkdirSync(pnyxHome(), { recursive: true })

  try {
    writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    // Another process created it first; use theirs.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  return readFileSync(path, 'utf8').trim()
}

export function boardIdentity({ board }: { board: string }): string {
  return createHash('sha256').update(localToken())
    .update(board)
    .digest('hex')
    .slice(0, 24)
}

function processStart({ pid }: { pid: number }): string | null {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    }).trim() || null
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      return null
    }

    throw error
  }
}

export function claimServer({ board }: { board: string }): () => void {
  const path = join(boardDir({ board }), 'server.lock')
  const started = processStart({ pid: process.pid })

  if (!started) {
    throw new BoardError({ message: 'could not identify the server process', code: 'SERVER_UNAVAILABLE' })
  }

  const owner = JSON.stringify({ pid: process.pid, processStart: started })
  withWriter({
    board,
    fn: () => {
      let previous: { pid?: unknown; processStart?: unknown } | null = null

      try {
        previous = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      if (typeof previous?.pid === 'number' && Number.isInteger(previous.pid) && previous.pid > 0
      && typeof previous.processStart === 'string'
      && processStart({ pid: previous.pid }) === previous.processStart) {
        throw new BoardError({ message: `a server already owns board ${board}`, code: 'ALREADY_RUNNING' })
      }

      writeFileSync(path, owner, { mode: 0o600 })
    },
  })

  return () => withWriter({
    board,
    fn: () => {
      if (readFileSync(path, 'utf8') === owner) {
        rmSync(path, { force: true })
      }
    },
  })
}
