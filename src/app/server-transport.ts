import type { ThreadDelta } from '#hydra/thread-delta.ts'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { commands as cliCommands } from './cli.ts'
import { approval } from './confirmations.ts'
import { project } from '#projects/cli.ts'
import { dispatchCommands } from '#workers/dispatch-cli.ts'
import type { ThreadPage, LatestMessage } from '#hydra/transcripts-read.ts'
import type { TaskSpend } from '#workers/task-spend.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import type { ClientMessage } from './server-http.ts'

export const commands = {
  ...cliCommands,
  approval,
  project,
  ...dispatchCommands,
}

export const SOCKET_RETRY_MS = 100

// A tab with more than this unsent holds its latest batch until it drains and misses the messages it cannot get later.
export const MAX_BUFFERED = 1 << 20

export const MAX_BODY = 1 << 20

export const STOP_TIMEOUT_MS = 5000

export { CLI_COMMANDS } from './command-registry.ts'

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

// Server to browser: live agent activity and conversation pages, beside the Hydra data the page reads through Zero.
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
    type: 'thread.delta'
    delta: ThreadDelta
  }
  // Last conversation messages and current actions by card: all of them on connect, then the ones that changed (null when gone).
  | {
    type: 'latest'
    spend?: Record<string, TaskSpend>
    usage?: Record<string, import('#workers/provider.ts').AgentUsage>
    messages: Record<string, LatestMessage | null>
    actions: Record<string, CurrentAction | null>
  }
  | {
    type: 'receipt'
    id: string
    thread?: ThreadPage
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
  // The zero-cache child's pid while it runs; undefined when the server was started without it.
  zeroCachePid(): number | undefined
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
    page,
  }: {
    ws: HydraClient
    page?: string[]
  }): HydraSubscription
  settings(): void
  close(): Promise<void>
}

export type HydraRequest = {
  req: IncomingMessage
  res: ServerResponse
  path: string
  search: string
}

export const HYDRA_PATH = /^\/hydra\/([^/]+)(\/.*)?$/

export { ZERO_OWNER, ZERO_PATH } from './server-protocol.ts'
export const ZERO_COOKIE = 'pnyx-token'
export const ZERO_QUERY_PATH = '/zero-query'

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
