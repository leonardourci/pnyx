import type { ThreadDelta } from '#titan/thread-delta.ts'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { commands as cliCommands } from './cli.ts'
import { approval } from './confirmations.ts'
import { project } from '#projects/cli.ts'
import { dispatchCommands } from '#workers/dispatch-cli.ts'
import type { ThreadPage, LatestMessage } from '#titan/transcripts-read.ts'
import type { TaskSpend } from '#workers/task-spend.ts'
import type { CurrentAction } from '#titan/calls.ts'
import type { ClientMessage } from './server-http.ts'
import type { HomeMessage, TitanPage } from './socket-state.ts'

export const commands = {
  ...cliCommands,
  approval,
  project,
  ...dispatchCommands,
}

export { MAX_BODY } from './server-protocol.ts'

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
  '.webmanifest': 'application/manifest+json',
}

// Each command gets a receipt or an error carrying its id.
type ServerPayload =
  | {
    type: 'hello'
    stateSeq?: number
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

export type ServerMessage = (ServerPayload | HomeMessage | {
  type: 'scope-error'
  scope: string
  error: string
  code: string
}) & {
  scope?: string
  subscription?: string
}

export interface TitanClient {
  readonly bufferedAmount: number
  readonly readyState: number
  readonly OPEN: number
  send({
    message,
    snapshot,
  }: {
    message: ServerMessage
    snapshot?: boolean
  }): boolean
  terminate(): void
}

export interface TitanSubscription {
  receive({ message }: { message: ClientMessage | undefined }): void
  close(): void
}

export interface RunningServer {
  port: number
  // The server's root address, which opens an active Titan.
  url: string
  socket: string | null
  // Titans that could not be loaded, with the reason; the others keep working.
  skipped: Record<string, string>
  open({ id }: { id: string }): Promise<string>
  close(): Promise<void>
}

export interface MountedTitan {
  url: string
  socket: string | null
  view(): TitanPage
  request({
    req,
    res,
    path,
    search,
  }: TitanRequest): void | Promise<void>
  connect({
    ws,
    page,
  }: {
    ws: TitanClient
    page?: string[]
  }): TitanSubscription
  settings(): void
  close({ permanent }?: { permanent?: boolean }): Promise<void>
}

export type TitanRequest = {
  req: IncomingMessage
  res: ServerResponse
  path: string
  search: string
}

export const TITAN_PATH = /^\/hydra\/([^/]+)(\/.*)?$/

// A target such as // reads as a URL with an empty host, which throws; take it as a path instead.
export const requestUrl = ({ url = '/' }: { url?: string }) => URL.parse(
  url,
  'http://localhost',
) ?? new URL(`http://localhost${url}`)

// Exact matches refuse other sites and rebound DNS names; *.localhost names (portless's
// https://othrys.localhost) pass because browsers resolve them to loopback (RFC 6761).
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
  allowedHosts,
}: {
  host?: string
  origin?: string
  hosts: Set<string>
  origins: Set<string>
  allowedHosts: string[]
}) => {
  const hostAllowed = hosts.has(host) || localHost.test(host) || allowedHosts.includes(host.toLowerCase())
  const originAllowed = origin === undefined || origins.has(origin) || localOrigin.test(origin)
    || allowedHosts.some(name => origin === `https://${name}`)

  return hostAllowed && originAllowed
}
