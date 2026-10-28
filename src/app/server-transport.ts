import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { commands as cliCommands } from './cli.ts'
import { approval } from './confirmations.ts'
import { project } from '../projects/cli.ts'
import { dispatchCommands } from '../workers/dispatch-cli.ts'
import type { ThreadPage, LatestMessage } from '../thread/read.ts'
import type { HydraState, HydraEvent } from './model.ts'
import type { TaskSpend } from '../workers/task-spend.ts'
import type { CurrentAction } from '../thread/calls.ts'
import type { HydraSummary } from './server-hydras.ts'
import type { UpgradeStatus } from '../upgrade/model.ts'
import type { HydraQueue } from './host.ts'
import type { ClientMessage } from './server-http.ts'

export const commands = {
  ...cliCommands,
  approval,
  project,
  ...dispatchCommands,
}

// Events kept in memory for cursor resume; an older cursor gets a snapshot instead.
export const RESUME_LIMIT = 1000

// A tab with more than this unsent is dropped from the event stream and resynced with a snapshot.
export const MAX_BUFFERED = 1 << 20

export const MAX_BODY = 1 << 20

export const STOP_TIMEOUT_MS = 5000

// CLI commands exposed to the browser; history and card only read. push and repair stay CLI-only: push reads a file path, repair is maintenance.
export const CLI_COMMANDS = [
  'approval',
  'project',
  'task',
  'column',
  'hydra',
  'layout',
  'rule',
  'account',
  'move',
  'link',
  'outcome',
  'undo',
  'view',
  'history',
  'card',
  'integrations',
] as const

export const WEB_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'web',
)

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

// Server to browser. A snapshot replaces whatever the tab held; events then follow in sequence.
// Each command gets a receipt or an error carrying its id.
type ServerPayload =
  | {
    type: 'hello'
    build: string
    hydraId: string
    installation: string
  }
  | { type: 'pong' }
  | {
    type: 'thread'
    thread: ThreadPage
  }
  | {
    type: 'snapshot'
    seq: number
    state: HydraState
  }
  | {
    type: 'event'
    event: HydraEvent
  }
  // Last conversation messages and current actions by card: all of them on connect, then the ones that changed (null when gone).
  | {
    type: 'latest'
    spend?: Record<string, TaskSpend>
    messages: Record<string, LatestMessage | null>
    actions: Record<string, CurrentAction | null>
  }
  | {
    type: 'hydras'
    hydraId: string
    hydras: HydraSummary[]
  }
  // What the daily check found; sent on connect once known, then whenever it changes.
  | {
    type: 'upgrade'
    upgrade: UpgradeStatus
  }
  // Hydra's unread changes: after a snapshot when there are any, then again whenever they change.
  | {
    type: 'hydraQueue'
    queue: HydraQueue
  }
  | {
    type: 'receipt'
    id: string
    [field: string]: unknown
  }
  | {
    type: 'error'
    id: string | null
    error: string
    code: string
    help?: string[]
    saved?: boolean
  }

export type ServerMessage = (ServerPayload | {
  type: 'scope-error'
  scope: string
  error: string
  code: string
}) & {
  scope?: string
  subscription?: string
}

export interface HydraClient {
  readonly bufferedAmount: number
  readonly readyState: number
  readonly OPEN: number
  send({ message }: { message: ServerMessage }): void
  terminate(): void
}

export interface HydraSubscription {
  receive({ message }: { message: ClientMessage | undefined }): void
  close(): void
}

export interface RunningServer {
  port: number
  // The address of the Hydra startServer was asked for.
  url: string
  socket: string | null
  // Hydras that could not be loaded, with the reason; the others keep working.
  skipped: Record<string, string>
  open({ id }: { id: string }): Promise<string>
  close(): Promise<void>
}

export interface MountedHydra {
  url: string
  socket: string | null
  request({
    req,
    res,
    path,
    search,
  }: HydraRequest): void | Promise<void>
  connect({
    ws,
    after,
  }: {
    ws: HydraClient
    after: string | null
  }): HydraSubscription
  summaries({ hydras }: { hydras: HydraSummary[] }): void
  upgrade(): void
  close(): Promise<void>
}

export type HydraRequest = {
  req: IncomingMessage
  res: ServerResponse
  path: string
  search: string
}

export const HYDRA_PATH = /^\/hydra\/([^/]+)(\/.*)?$/

// A target such as // reads as a URL with an empty host, which throws; take it as a path instead.
export const requestUrl = ({ url = '/' }: { url?: string }) => URL.parse(
  url,
  'http://localhost',
) ?? new URL(`http://localhost${url}`)

// Exact matches refuse other sites and rebound DNS names; *.localhost names (portless's
// https://pnyx.localhost) pass because browsers resolve them to loopback (RFC 6761).
const localName = String.raw`[a-z0-9.-]+\.localhost(:\d+)?`

const localHost = new RegExp(
  `^${localName}$`,
  'i',
)

const localOrigin = new RegExp(
  `^https?://${localName}$`,
  'i',
)

export const allowedRequest = ({
  host = '',
  origin,
  hosts,
  origins,
}: {
  host?: string
  origin?: string
  hosts: Set<string>
  origins: Set<string>
}) => (hosts.has(host) || localHost.test(host))
  && (origin === undefined || origins.has(origin) || localOrigin.test(origin))
