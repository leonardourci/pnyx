import { doneDeadline } from '../core/retention.ts'
import { hideDone } from '../store/retention.ts'
import { execFile } from 'node:child_process'
import { latestMessage, readThread, threadPath, THREAD_CURSOR, type LatestMessage, type LatestRead, type ThreadPage } from '../thread/read.ts'
import { readCatalog, type Catalog, type CatalogLocations } from '../thread/catalog.ts'
import { HYDRA_CARD } from '../core/hydra.ts'
import { findCard } from '../core/decide.ts'
import { replyRoute } from '../core/route.ts'
import { PASEO_CURSOR, paseoConversation, type PaseoConversation } from '../integrations/paseo/thread.ts'
import { watchHomes } from '../integrations/firstmate/cli.ts'
import { resolveHome } from '../integrations/firstmate/home.ts'
import { queryOracle, matchActions } from '../oracle/semantic.ts'
import { readSettings, settingEntries, writeSetting } from '../oracle/settings.ts'
import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createSocketServer, type Server as SocketServer } from 'node:net'
import type { Duplex } from 'node:stream'
import { basename, dirname, extname, join, normalize } from 'node:path'
import { parseArgs } from 'node:util'
import { AxiError } from 'axi-sdk-js'
import { WebSocketServer, type WebSocket } from 'ws'
import { ingestSpool } from '../integrations/hooks/ingest.ts'
import { commands as cliCommands } from '../cli/commands.ts'
import { integrationsCommand } from '../cli/integrations.ts'
import { workerCommands } from '../cli/workers.ts'
import { HydraError, type HydraEvent, type HydraState, type Card, type ViewPreferences } from '../core/model.ts'
import { reduce } from '../core/reducer.ts'
import { traces, viewFor } from '../core/view.ts'
import { hydraDir, loadHydra, pnyxHome, privateDir, readEventsFrom, spoolDir, spoolFiles, spoolWrite } from '../store/hydra-store.ts'
import { DEFAULT_PORT, hydraIdentity, claimServer, infoPath, localToken, readServer, socketPath, type ServerInfo } from './state.ts'
import { createHydra, hydraIds, listHydras, renameHydra } from './hydras.ts'
import { createHost, hostRequest, type QueryFn } from './host.ts'
import type { SpawnCodex } from './codex.ts'

// The browser edits kinds; Hydra's check and start stay in the CLI.
const commands = { ...cliCommands, kind: workerCommands.kind }
// Events kept in memory for cursor resume; an older cursor gets a snapshot instead.
const RESUME_LIMIT = 1000
// A tab with more than this unsent is dropped from the event stream and resynced with a snapshot.
const MAX_BUFFERED = 1 << 20
const MAX_BODY = 1 << 20
const STOP_TIMEOUT_MS = 5000
const ORACLE_LIMIT = 100

const shownTraces = ({ view, card }: { view: ViewPreferences; card: string }) => {
  const { tools, thinking } = traces({ view: viewFor({ state: { view } }), card })

  return `${tools}:${thinking}`
}

const LATEST_DELAY_MS = 200
// CLI commands exposed to the browser; history and card only read. push and repair stay CLI-only: push reads a file path, repair is maintenance.
const CLI_COMMANDS = ['task', 'column', 'hydra', 'layout', 'kind', 'move', 'link', 'outcome', 'undo', 'view', 'history', 'card', 'integrations'] as const
const WEB_ROOT = join(import.meta.dirname, '..', '..', 'dist', 'web')
const MIME: Record<string, string> = {
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
export type ServerMessage =
  | { type: 'hello'; build: string; hydraId: string }
  | { type: 'pong' }
  | { type: 'thread'; thread: ThreadPage }
  | { type: 'snapshot'; seq: number; state: HydraState }
  | { type: 'event'; event: HydraEvent }
  // Last conversation messages by card: all of them on connect, then the ones that changed (null when gone).
  | { type: 'latest'; messages: Record<string, LatestMessage | null> }
  | { type: 'receipt'; id: string; [field: string]: unknown }
  | { type: 'error'; id: string | null; error: string; code: string; help?: string[] }

export interface RunningServer {
  port: number
  // The address of the Hydra startServer was asked for.
  url: string
  socket: string | null
  // Hydras that could not be loaded, with the reason; the others keep working.
  skipped: Record<string, string>
  close(): Promise<void>
}

// One request handler, WebSocket and hook socket per Hydra, all inside this server.
interface MountedHydra {
  url: string
  socket: string | null
  request({ req, res, path }: HydraRequest): void
  upgrade({ req, socket, head, url }: HydraUpgrade): void
  close(): Promise<void>
}

type HydraRequest = { req: IncomingMessage; res: ServerResponse; path: string }
type HydraUpgrade = { req: IncomingMessage; socket: Duplex; head: Buffer; url: URL }

const HYDRA_PATH = /^\/hydra\/([^/]+)(\/.*)?$/
const RETRY_MS = 60_000

// Serves every Hydra under $PNYX_HOME on one port, each at /hydra/<id>/, and / opens the
// named Hydra. It (with any homes given for it) and the default Hydra must load; any other
// Hydra that fails is skipped and reported. A Hydra folder created later is served once it appears.
export async function startServer({ hydraId = 'default', port = 0, homes, ...options }: {
  hydraId?: string
  port?: number
  homes?: string[]
  catalogLocations?: CatalogLocations
  // The Agent SDK's query; tests pass a fake.
  query?: QueryFn
  spawnCodex?: SpawnCodex
}): Promise<RunningServer> {
  const mounts = new Map<string, Promise<MountedHydra>>()
  const served = new Map<string, MountedHydra>()
  const skipped: Record<string, string> = {}
  let closed = false

  // Exact matches only, so another site or a rebound DNS name is refused. Clients
  // that send no Origin are local programs, not pages; writes still need the token.
  const hosts = new Set<string>()
  const origins = new Set<string>()
  const allowed = ({ req }: { req: IncomingMessage }) =>
    hosts.has(req.headers.host ?? '') && (req.headers.origin === undefined || origins.has(req.headers.origin))

  const http = createServer((req, res) => {
    if (!allowed({ req })) {
      return reply({ res, status: 403, body: { error: 'origin or host not allowed', code: 'FORBIDDEN' } })
    }

    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const [, id, rest] = HYDRA_PATH.exec(path) ?? []

    if (id !== undefined) {
      const mount = served.get(id)

      if (!mount) {
        return reply({ res, status: 404, body: { error: `Hydra not served: ${id}`, code: 'NOT_FOUND', ...(skipped[id] ? { reason: skipped[id] } : {}) } })
      }

      if (rest === undefined) {
        return void res.writeHead(308, { location: `/hydra/${id}/` }).end()
      }

      return mount.request({ req, res, path: rest })
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply({ res, status: 405, body: { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' } })
    }

    if (path === '/health') {
      const hydras = [...served.keys()].sort()
      const body = { pid: process.pid, build: buildId(), hydras, skipped }

      return reply({ res, status: 200, body })
    }

    if (path === '/') {
      return void res.writeHead(302, { location: `/hydra/${hydraId}/` }).end()
    }

    serveStatic({ res, path })
  })

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // ponytail: /ws, like /, is the named Hydra's: a tab opened before one server ran every
    // Hydra reconnects and reloads, and the Vite dev page at / reaches the dev Hydra.
    const [, id, rest] = url.pathname === '/ws' ? ['', hydraId, '/ws'] : HYDRA_PATH.exec(url.pathname) ?? []
    const mount = id === undefined ? undefined : served.get(id)

    if (!mount || rest !== '/ws' || !allowed({ req })) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')

      return
    }

    mount.upgrade({ req, socket, head, url })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, '127.0.0.1', () => resolve())
  })
  const bound = (http.address() as { port: number }).port

  for (const host of [`127.0.0.1:${bound}`, `localhost:${bound}`]) {
    hosts.add(host)
    origins.add(`http://${host}`)
  }

  const mount = ({ id }: { id: string }): Promise<MountedHydra> => {
    const known = mounts.get(id)

    if (known) {
      return known
    }

    if (closed) {
      return Promise.reject(new HydraError({ message: 'the server is stopping', code: 'NOT_RUNNING' }))
    }

    const started = mountHydra({ hydraId: id, url: `http://127.0.0.1:${bound}/hydra/${id}/`, homes: id === hydraId ? homes : undefined, open, ...options })
    mounts.set(id, started)
    started.then(m => {
      if (closed) {
        void m.close()
      } else {
        served.set(id, m)
        delete skipped[id]
      }
    }, (error: Error) => {
      mounts.delete(id)
      skipped[id] = error.message
    })

    return started
  }

  async function open({ id }: { id: string }): Promise<string> {
    if (!hydraIds().includes(id)) {
      throw new HydraError({ message: `Hydra not found: ${id}`, code: 'NOT_FOUND' })
    }

    return (await mount({ id })).url
  }

  let named: MountedHydra

  // A skipped Hydra is tried again, as one held by an older server is free once that server stops;
  // its reason is logged only when it changes.
  const mountAll = () => {
    for (const id of hydraIds()) {
      const before = skipped[id]

      if (!closed && !mounts.has(id)) {
        mount({ id }).catch((error: Error) => error.message !== before && console.error(`pnyx-axi serve: skipped Hydra ${id}: ${error.message}`))
      }
    }
  }

  const boards = join(pnyxHome(), 'boards')
  mkdirSync(boards, { recursive: true })
  const watcher = watch(boards, mountAll)
  const retry = setInterval(mountAll, RETRY_MS).unref()

  const close = async () => {
    closed = true
    watcher.close()
    clearInterval(retry)
    const all = await Promise.allSettled(mounts.values())
    await Promise.all(all.flatMap(m => m.status === 'fulfilled' ? [m.value.close()] : []))
    http.closeAllConnections()
    await new Promise(r => http.close(r))
  }

  try {
    named = await mount({ id: hydraId })
    await mount({ id: 'default' })
  } catch (error) {
    await close()
    throw error
  }

  await Promise.allSettled(hydraIds().map(id => mount({ id })))

  return { port: bound, url: named.url, socket: named.socket, skipped: { ...skipped }, close }
}

async function mountHydra({
  hydraId,
  url,
  homes,
  catalogLocations,
  query, spawnCodex,
  open,
}: {
  hydraId: string
  url: string
  // Firstmate homes for replies; without them, the Hydra's recorded home, which is also watched.
  homes?: string[]
  catalogLocations?: CatalogLocations
  query?: QueryFn
  spawnCodex?: SpawnCodex
  open({ id }: { id: string }): Promise<string>
}): Promise<MountedHydra> {
  const release = claimServer({ hydraId })

  try {
    return await mountOwnedHydra({
      hydraId, url, homes, catalogLocations, query, spawnCodex, open, release,
    })
  } catch (error) {
    release()
    throw error
  }
}

async function mountOwnedHydra({
  hydraId,
  url,
  homes: given,
  catalogLocations,
  query, spawnCodex,
  open,
  release,
}: {
  hydraId: string
  url: string
  homes?: string[]
  catalogLocations?: CatalogLocations
  query?: QueryFn
  spawnCodex?: SpawnCodex
  open({ id }: { id: string }): Promise<string>
  release(): void
}): Promise<MountedHydra> {
  if (await readServer({ hydraId })) {
    throw new HydraError({ message: `a server is already running for Hydra ${hydraId}`, code: 'ALREADY_RUNNING', help: ['Run `pnyx-axi` to see its address'] })
  }

  let homes = (given ?? []).map(path => resolveHome({ path }))
  type Subscription = {
    card: string
    path?: string
    paseo?: string
    watcher?: { close(): unknown }
    native?: Promise<PaseoConversation>
  }
  const subscriptions = new Map<WebSocket, Subscription>()
  const hydraSubscriptions = new Map<WebSocket, Subscription>()
  const threadSubscriptions = [subscriptions, hydraSubscriptions]
  const subscriptionMap = ({ card }: { card: string }) =>
    card === HYDRA_CARD ? hydraSubscriptions : subscriptions
  const threadTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>()
  // Set by close(): work already scheduled then must not open new watchers or timers.
  let closed = false

  const refreshThread = ({ ws }: { ws: WebSocket }) => {
    if (closed || threadTimers.has(ws)) {
      return
    }

    threadTimers.set(ws, setTimeout(() => {
      threadTimers.delete(ws)

      if (ws.readyState !== ws.OPEN) {
        return
      }

      for (const map of threadSubscriptions) {
        const sub = map.get(ws), card = sub && state.cards[sub.card]

        if (!card) {
          continue
        }

        const unavailable = () => send({ ws, message: { type: 'error', id: null, code: 'THREAD_UNAVAILABLE', error: 'Conversation could not be refreshed' } })

        if (sub.native) {
          void sub.native.then(n => n.read({})).then(thread => {
            if (map.get(ws) === sub && ws.readyState === ws.OPEN) {
              send({ ws, message: { type: 'thread', thread } })
            }
          }, unavailable)

          continue
        }

        try {
          send({ ws, message: { type: 'thread', thread: readThread({ hydraId, state, card, homes }) } })
        } catch {
          unavailable()
        }
      }
    }, LATEST_DELAY_MS))
  }

  const threadPage = async ({ sub, card, before }: {
    sub: Subscription
    card: Card
    before?: string
  }): Promise<ThreadPage> => {
    if (!sub.native) {
      return readThread({ hydraId, state, card, homes, before })
    }

    try {
      return await (await sub.native).read({ before })
    } catch (error) {
      // Replies sent from here still show while Paseo cannot be read.
      return { ...readThread({ hydraId, state, card, homes }), unavailable: `${error instanceof HydraError ? error.message : 'Paseo could not read this conversation'}; it shows again once Paseo answers.` }
    }
  }

  const bindThread = ({ ws, card }: { ws: WebSocket; card: Card }) => {
    const map = subscriptionMap({ card: card.id })
    map.get(ws)?.watcher?.close()
    const path = threadPath({ card })
    const sub: Subscription = { card: card.id, path }
    const paseo = card.agent?.paseoAgentId

    if (paseo) {
      const native = paseoConversation({ card, changed: () => refreshThread({ ws }) })
      native.catch(() => undefined)
      const watcher = { close: () => void native.then(n => n.close(), () => undefined) }
      Object.assign(sub, { paseo, native, watcher })
    } else if (path) {
      try {
        sub.watcher = watch(dirname(path), (_event, filename) => {
          if (!filename || String(filename) === basename(path)) {
            refreshThread({ ws })
          }
        })
      } catch { /* Missing transcript remains explicit. */ }
    }

    map.set(ws, sub)
  }

  const dir = hydraDir({ hydraId })
  privateDir({ dir: spoolDir({ dir }) })
  const token = Buffer.from(localToken())
  const identity = hydraIdentity({ hydraId })
  let { state, offset } = loadHydra({ hydraId })
  // The recorded Firstmate home is watched, and followed when it changes; given homes stay fixed.
  let firstmate: ReturnType<typeof watchHomes> | undefined
  let watchedHome: string | undefined

  const followHome = () => {
    const hydra = state.config?.hydra
    // A recorded home that has since moved is skipped, so the Hydra still opens.
    const home = hydra?.kind === 'firstmate' && hydra.home && existsSync(join(hydra.home, 'state')) ? hydra.home : undefined

    if (given || closed || home === watchedHome) {
      return
    }

    firstmate?.close()
    watchedHome = home
    homes = home ? [resolveHome({ path: home })] : []
    firstmate = home ? watchHomes({ hydraId, list: homes }) : undefined
  }

  let recent: HydraEvent[] = []
  const resyncing = new WeakSet<WebSocket>()

  const send = ({ ws, message }: { ws: WebSocket; message: ServerMessage }) => {
    if (ws.bufferedAmount > MAX_BUFFERED) {
      resyncing.add(ws)

      return
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message))
    }
  }

  const sendSnapshot = ({ ws }: { ws: WebSocket }) => {
    resyncing.delete(ws)
    send({ ws, message: { type: 'snapshot', seq: state.seq, state } })
    ws.send(JSON.stringify({ type: 'latest', messages: latest } satisfies ServerMessage))
  }

  // ponytail: a lagging tab gets its snapshot on the next change, not when its buffer drains.
  const broadcast = ({ event }: { event: HydraEvent }) => {
    for (const ws of wss.clients) {
      if (!resyncing.has(ws)) {
        send({ ws, message: { type: 'event', event } })
      } else if (ws.bufferedAmount <= MAX_BUFFERED) {
        sendSnapshot({ ws })
      }

      for (const map of threadSubscriptions) {
        const sub = map.get(ws)

        // A view change that switches this card's traces on or off changes its page.
        if (sub && (sub.card === event.cardId
        || (event.type === 'task.session' && sub.card === event.data.before)
        || (event.type === 'board.view' &&
          shownTraces({ view: event.data.before, card: sub.card })
          !== shownTraces({ view: event.data.after, card: sub.card })))) {
          const card = state.cards[sub.card]

          if (card && (sub.path !== threadPath({ card })
            || sub.paseo !== card.agent?.paseoAgentId)) {
            bindThread({ ws, card })
          }

          refreshThread({ ws })
        }
      }
    }
  }

  const reload = () => {
    ({ state, offset } = loadHydra({ hydraId }))
    recent = []
    agents.reconcile({ state })
    followHome()

    for (const ws of wss.clients) {
      sendSnapshot({ ws })
    }

    touchLatest({ ids: Object.keys(state.cards) })
  }

  // Each card's last conversation message, read from its transcript tail and pushed
  // to every tab. A card is read again when it gets an event or its transcript
  // changes: transcript folders are watched, as a live session writes between hook events.
  // ponytail: one watcher per transcript folder, never released while the server runs; release ended sessions' folders if that grows.
  const latest: Record<string, LatestMessage> = {}
  const reads = new Map<string, LatestRead>()
  const folders = new Map<string, FSWatcher>()
  const unread = new Set<string>()
  let latestTimer: ReturnType<typeof setTimeout> | undefined

  const watchFolder = ({ dir }: { dir: string }) => {
    if (closed || folders.has(dir)) {
      return
    }

    try {
      const watcher = watch(dir, (_event, filename) => {
        const changed = filename ? join(dir, String(filename)) : undefined
        touchLatest({
          ids: Object.values(state.cards).filter(c => {
            const path = threadPath({ card: c })

            return path && (changed ? path === changed : dirname(path) === dir)
          })
            .map(c => c.id),
        })
      })
      watcher.on('error', () => {
        watcher.close(); folders.delete(dir)
      })
      folders.set(dir, watcher)
    } catch {
      // A missing folder is watched once the card's next event reads it again.
    }
  }

  const readLatest = () => {
    latestTimer = undefined
    const changed: Record<string, LatestMessage | null> = {}

    for (const id of unread) {
      const card = state.cards[id], path = card && threadPath({ card })

      if (path) {
        watchFolder({ dir: dirname(path) })
      }

      const read = path ? latestMessage({ path, prev: reads.get(id) }) : undefined

      if (read) {
        reads.set(id, read)
      } else {
        reads.delete(id)
      }

      const message = read?.message ?? null

      if (JSON.stringify(message) === JSON.stringify(latest[id] ?? null)) {
        continue
      }

      if (message) {
        latest[id] = message
      } else {
        delete latest[id]
      }

      changed[id] = message
    }

    unread.clear()

    if (Object.keys(changed).length) {
      for (const ws of wss.clients) {
        send({ ws, message: { type: 'latest', messages: changed } })
      }
    }
  }

  function touchLatest({ ids }: { ids: Iterable<string> }) {
    if (closed) {
      return
    }

    for (const id of ids) {
      unread.add(id)
    }

    if (unread.size) {
      latestTimer ??= setTimeout(readLatest, LATEST_DELAY_MS)
    }
  }

  const pump = () => {
    const read = readEventsFrom({ hydraId, offset })

    if (!read) {
      return reload()
    }

    for (const event of read.events) {
      if (event.seq !== state.seq + 1) {
        return reload()
      }

      state = reduce({ state, event })
      recent.push(event)
      broadcast({ event })
      touchLatest({ ids: [event.cardId] })
    }

    offset = read.end
    agents.reconcile({ state })
    followHome()

    if (recent.length > RESUME_LIMIT) {
      recent = recent.slice(-RESUME_LIMIT)
    }
  }

  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let scheduled = false

  const kick = () => {
    if (closed || scheduled) {
      return
    }

    scheduled = true
    setImmediate(() => {
      scheduled = false

      if (closed) {
        return
      }

      try {
        if (spoolFiles({ dir }).length > 0) {
          ingestSpool({ hydraId })
        }

        pump()

        const deadline = doneDeadline({ state })

        if (deadline !== undefined && deadline <= Date.now()) {
          hideDone({ hydraId })
          pump()
        }
      } catch (error) {
        // A held lock or a damaged log; the next change retries.
        console.error(`pnyx-axi serve: ${(error as Error).message}`)
      } finally {
        clearTimeout(expiryTimer)
        const deadline = doneDeadline({ state })

        if (deadline !== undefined) {
          expiryTimer = setTimeout(kick, Math.max(100, Math.min(60_000, deadline - Date.now())))
        }
      }
    })
  }

  const authorized = ({ given }: { given: string | null }) => {
    const bytes = Buffer.from(given ?? '')

    return token.length > 0 && bytes.length === token.length && timingSafeEqual(bytes, token)
  }

  const agents = createHost({ hydraId, query, spawnCodex, changed: () => kick() })

  // The server has already checked Host and Origin.
  const request = ({ req, res, path }: HydraRequest) => {
    // The CLI asks here to start or message an agent this server runs. A page cannot
    // send this header cross-origin without a preflight, which this server never answers.
    if (req.method === 'POST' && path === '/host') {
      if (!authorized({ given: req.headers.authorization?.replace(/^Bearer /, '') ?? null })) {
        return reply({ res, status: 401, body: { error: 'missing or wrong token', code: 'UNAUTHORIZED' } })
      }

      return void readBody({ req }).then(body => hostRequest({ host: agents, body }))
        .then(
          answer => reply({ res, status: 200, body: answer }),
          (error: Error) => reply({ res, status: 400, body: { error: error.message, code: error instanceof HydraError ? error.code : 'UNKNOWN', help: error instanceof HydraError ? error.help : [] } }),
        )
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply({ res, status: 405, body: { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' } })
    }

    if (path === '/health') {
      return reply({ res, status: 200, body: { hydraId, pid: process.pid, build: buildId() } })
    }

    const page = { token: token.toString(), identity, base: new URL(url).pathname }
    serveStatic({ res, path, page })
  }

  const catalogReads = new WeakMap<WebSocket, { card: string; read: Promise<Catalog> }>()

  const runCommand = ({ ws, message }: {
    ws: WebSocket
    message: { id?: unknown; name?: unknown; args?: unknown }
  }) => {
    const id = typeof message.id === 'string' ? message.id : null
    const fail = ({ error, code, help }: { error: string; code: string; help?: string[] }) => send({ ws, message: { type: 'error', id, error, code, help } })
    const { name, args } = message

    if (id === null) {
      return fail({ error: 'command needs a string id', code: 'VALIDATION_ERROR' })
    }

    if (['thread', 'oracle', 'oracle-commands', 'reply', 'answer', 'agent', 'catalog', 'settings', 'hydras'].includes(String(name))) {
      if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
        return fail({ error: 'args must be strings', code: 'VALIDATION_ERROR' })
      }

      try {
        if (name === 'catalog') {
          if (args.length !== 1) {
            throw new HydraError({ message: 'catalog expects a card', code: 'VALIDATION_ERROR' })
          }

          const card = findCard({ state, ref: args[0] })
          let entry = catalogReads.get(ws)

          if (entry?.card !== card.id) {
            const previous = entry?.read.catch(() => undefined)
            const next = {
              card: card.id,
              read: Promise.resolve(previous).then(() => readCatalog({
                card,
                locations: catalogLocations,
              })),
            }
            catalogReads.set(ws, entry = next)
            void next.read.catch(() => undefined).finally(() => {
              if (catalogReads.get(ws) === next) {
                catalogReads.delete(ws)
              }
            })
          }

          void entry.read.then(catalog => send({ ws, message: { type: 'receipt', id, catalog } })).catch(() => fail({ error: 'Local catalog unavailable', code: 'CATALOG_UNAVAILABLE' }))
        } else if (name === 'oracle') {
          if (args.length > 3 || (args[2] !== undefined && args[2] !== 'hydra')) {
            throw new HydraError({ message: 'oracle expects text, optional workspace and optional Hydra scope', code: 'VALIDATION_ERROR' })
          }

          const query = { text: args[0] ?? '', ...(args[1] ? { workspace: args[1] } : {}), ...(args[2] === 'hydra' ? { live: true } : {}), limit: ORACLE_LIMIT }

          void queryOracle({ hydraId, query })
            .then(result => send({ ws, message: { type: 'receipt', id, ...result } }))
            .catch((error: Error) => fail({ error: error.message, code: error instanceof HydraError ? error.code : 'UNKNOWN' }))
        } else if (name === 'oracle-commands') {
          let entries: unknown

          try {
            entries = JSON.parse(args[1] ?? '[]')
          } catch {
            throw new HydraError({ message: 'oracle-commands expects a JSON list of named entries', code: 'VALIDATION_ERROR' })
          }

          if (args.length !== 2 || !args[0]?.trim() || args[0].length > 500
            || !Array.isArray(entries) || entries.length > 256
            || !entries.every((entry: unknown): entry is { id: string; text: string } => !!entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string' && entry.id.length <= 160 && 'text' in entry && typeof entry.text === 'string' && entry.text.length <= 500)) {
            throw new HydraError({ message: 'oracle-commands expects a query and up to 256 named entries', code: 'VALIDATION_ERROR' })
          }

          void matchActions({ query: args[0], entries }).then(matches => send({ ws, message: { type: 'receipt', id, matches } }))
        } else if (name === 'settings') {
          if (args.length && (args.length !== 3 || args[0] !== 'set')) {
            throw new HydraError({ message: 'settings expects nothing, or set, a key and a value', code: 'VALIDATION_ERROR' })
          }

          const settings = args.length ? writeSetting({
            key: args[1]!,
            value: args[2]!,
          }) : readSettings({ })
          send({ ws, message: { type: 'receipt', id, settings: settingEntries({ settings }) } })
        } else if (name === 'hydras') {
          const [action, first, second] = args
          const reply = ({ open }: { open?: string } = {}) => send({ ws, message: { type: 'receipt', id, hydraId, hydras: listHydras(), ...(open ? { url: open } : {}) } })

          if (action === 'create' && first?.trim()) {
            void open({ id: createHydra({ name: first.trim().slice(0, 100) }) }).then(open => reply({ open }), (error: Error) => fail({ error: error.message, code: error instanceof HydraError ? error.code : 'UNKNOWN' }))
          } else if (action === 'open' && first) {
            void open({ id: first }).then(open => reply({ open }), (error: Error) => fail({ error: error.message, code: error instanceof HydraError ? error.code : 'UNKNOWN' }))
          } else if (action === 'rename' && first && second?.trim() && listHydras().some(b => b.id === first)) {
            renameHydra({ id: first, name: second.trim().slice(0, 100) })
            reply()
          } else if (action === undefined) {
            reply()
          } else {
            throw new HydraError({ message: 'Hydras expects nothing, open <id>, create <name> or rename <id> <name>', code: 'VALIDATION_ERROR' })
          }
        } else if (name === 'thread') {
          const map = subscriptionMap({ card: args[0] ?? '' })
          const old = map.get(ws); old?.watcher?.close(); map.delete(ws)

          if (!args[0]) {
            send({ ws, message: { type: 'receipt', id } })

            return
          }

          const card = findCard({ state, ref: args[0] })

          const cursor = card.agent?.paseoAgentId ? PASEO_CURSOR : THREAD_CURSOR

          if (args[1] !== undefined && (args[1].length > 200 || !cursor.test(args[1]))) {
            throw new HydraError({ message: 'invalid thread cursor', code: 'VALIDATION_ERROR' })
          }

          bindThread({ ws, card })
          const sub = map.get(ws)!
          void threadPage({ sub, card, before: args[1] }).then(thread => {
            if (ws.readyState === ws.OPEN) {
              send({ ws, message: { type: 'receipt', id, thread } })
            }
          }, (error: Error) => fail({ error: error.message, code: error instanceof HydraError ? error.code : 'UNKNOWN' }))
        } else {
          const agent = name === 'agent'
          const answering = name === 'answer'

          const valid = agent
            ? args.length === 4 && !!args[3]
            : answering
              ? args.length === 5 && args.every(Boolean) && args[2].length <= 32000
              : args.length === 3 && !!args[2] && args[1].length <= 32000

          if (!valid) {
            throw new HydraError({
              message: agent
                ? 'agent expects card, setting, value and idempotency key'
                : answering ? 'answer expects card, request key, answer, idempotency key and request id' : 'reply expects card, text and idempotency key',
              code: 'VALIDATION_ERROR',
            })
          }

          const card = findCard({ state, ref: args[0] })

          const found = replyRoute({ card, homes })

          if ('reason' in found) {
            throw new HydraError({ message: `${found.reason}${agent ? '' : ' Your draft stays here.'}`, code: 'NO_ROUTE' })
          }

          // A setting change is sent like a reply: `pnyx-axi agent` picks the harness's command and reads
          // it back. Its setting and value come last, after --, so neither can read as a flag.
          // An answer's values are passed as --name=value, so none can read as a flag.
          const [command, rest] = agent
            ? [['agent', card.id, '--idempotency-key', args[3]!], ['--', args[1]!, args[2]!]]
            : answering
              ? [['reply', card.id, `--answer=${args[1]}`, `--json=${args[2]}`, `--idempotency-key=${args[3]}`, `--seen=${args[4]}`], []]
              : [['reply', card.id, '--text', args[1], '--idempotency-key', args[2]], []]

          // The CLI owns reply writes and delivery. A child keeps slow native sends off the server event loop.
          execFile(process.execPath, [join(import.meta.dirname, '..', 'cli', import.meta.url.endsWith('.ts') ? 'reply-worker.ts' : 'reply-worker.js'), ...command, '--hydra', hydraId, '--actor', 'web', ...homes.flatMap(h => ['--home', h]), ...rest], { timeout: 130000, maxBuffer: MAX_BODY }, (error, stdout) => {
            kick()

            if (ws.readyState !== ws.OPEN) {
              return
            }

            if (error) {
              let known: { message?: unknown; code?: unknown; help?: string[] } | undefined

              try {
                known = JSON.parse(stdout).error
              } catch {
                known = undefined
              }

              if (typeof known?.message === 'string' && typeof known.code === 'string') {
                fail({ error: known.message, code: known.code, help: known.help })
              } else {
                fail({ error: 'Reply could not be confirmed; check receipts before sending again', code: 'DELIVERY_UNKNOWN' })
              }
            } else {
              try {
                send({ ws, message: { type: 'receipt', id, ...JSON.parse(stdout) } })
              } catch {
                fail({ error: 'Reply receipt unavailable; check history', code: 'DELIVERY_UNKNOWN' })
              }
            }
          })
        }
      } catch (error) {
        fail({ error: (error as Error).message, code: error instanceof HydraError ? error.code : 'UNKNOWN' })
      }

      return
    }

    if (typeof name !== 'string' || !(CLI_COMMANDS as readonly string[]).includes(name)) {
      return fail({ error: `unknown command: ${String(name)}`, code: 'NOT_FOUND', help: [`Use one of ${CLI_COMMANDS.join(', ')}`] })
    }

    if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
      return fail({ error: 'args must be [string, ...]', code: 'VALIDATION_ERROR' })
    }

    if (args.some(a => a === '--hydra' || a.startsWith('--hydra='))) {
      return fail({ error: `--hydra is not allowed; this server writes Hydra ${hydraId}`, code: 'VALIDATION_ERROR' })
    }

    const actor = name === 'history' || name === 'card' || name === 'integrations' || args.some(a => a === '--actor' || a.startsWith('--actor=')) ? [] : ['--actor', 'web']

    const failed = ({ error }: { error: unknown }) => error instanceof AxiError
      ? fail({ error: error.message, code: error.code, help: error.suggestions })
      : fail({ error: (error as Error).message, code: 'UNKNOWN' })

    try {
      const handler = name === 'integrations' ? integrationsCommand : commands[name as Exclude<(typeof CLI_COMMANDS)[number], 'integrations'>]
      void Promise.resolve(handler([...args, ...actor, '--hydra', hydraId])).then(result => {
        try {
          pump()
        } catch {
          kick()
        }

        send({ ws, message: { ...result, type: 'receipt', id } })
      }, error => failed({ error }))
    } catch (error) {
      failed({ error })
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

  // The server has already checked the path, Host and Origin.
  const upgrade = ({ req, socket, head, url }: HydraUpgrade) => {
    if (!authorized({ given: url.searchParams.get('token') })) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')

      return
    }

    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('close', () => {
        for (const map of threadSubscriptions) {
          map.get(ws)?.watcher?.close(); map.delete(ws)
        }
      })
      ws.on('message', data => {
        const message = parseMessage({ text: data.toString() })

        if (message?.type === 'ping') {
          send({ ws, message: { type: 'pong' } })
        } else if (message?.type === 'resync') {
          sendSnapshot({ ws })
        } else if (message?.type === 'command') {
          runCommand({ ws, message })
        } else {
          send({ ws, message: { type: 'error', id: null, error: 'unknown message', code: 'VALIDATION_ERROR', help: ['Send a command or resync message'] } })
        }
      })
      send({ ws, message: { type: 'hello', build: buildId(), hydraId: identity } })
      resume({ ws, after: url.searchParams.get('after') })
    })
  }

  // A cursor this server can continue from gets only the events after it; any
  // other cursor (ahead of the Hydra, older than the kept events, or none) gets a snapshot.
  // Either way the tab then gets every card's last message.
  const resume = ({ ws, after }: { ws: WebSocket; after: string | null }) => {
    const seq = after !== null && /^\d+$/.test(after) ? Number(after) : undefined
    const first = recent[0]?.seq ?? state.seq + 1

    if (seq === undefined || seq > state.seq || seq < first - 1) {
      return sendSnapshot({ ws })
    }

    for (const event of recent) {
      if (event.seq > seq) {
        send({ ws, message: { type: 'event', event } })
      }
    }

    send({ ws, message: { type: 'latest', messages: latest } })
  }

  const ingest = await listenIngest({
    hydraId,
    onLine: ({ line }) => {
      try {
        const entry = JSON.parse(line) as { id?: unknown }

        if (typeof entry === 'object' && entry !== null && typeof entry.id === 'string') {
          spoolWrite({ hydraId, entry: entry as { id: string } })
        }
      } catch {
      // Not JSON: dropped, as a hook never waits for an answer.
      }

      kick()
    },
  })

  const watchers: FSWatcher[] = []

  const stop = async () => {
    closed = true
    firstmate?.close()
    agents.close()

    const threads = threadSubscriptions.flatMap(map =>
      [...map.values()].flatMap(sub => sub.watcher ?? []))

    for (const w of [...watchers, ...folders.values(), ...threads]) {
      w.close()
    }

    folders.clear()
    threadSubscriptions.forEach(map => map.clear())
    clearTimeout(latestTimer)
    clearTimeout(expiryTimer)

    for (const timer of threadTimers.values()) {
      clearTimeout(timer)
    }

    threadTimers.clear()

    for (const ws of wss.clients) {
      ws.terminate()
    }

    wss.close()
    await (ingest && new Promise(r => ingest.close(r)))
    rmSync(infoPath({ hydraId }), { force: true })

    if (ingest) {
      rmSync(socketPath({ hydraId }), { force: true })
    }
  }

  const info: ServerInfo = {
    pid: process.pid,
    port: Number(new URL(url).port),
    url,
    socket: ingest && socketPath({ hydraId }),
  }

  // A mount that fails partway stops what it started; the caller releases the claim.
  try {
    watchers.push(watch(dir, kick), watch(spoolDir({ dir }), kick))
    followHome()
    const tmp = `${infoPath({ hydraId })}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(info))
    renameSync(tmp, infoPath({ hydraId }))
  } catch (error) {
    await stop()
    throw error
  }

  try {
    agents.recover()
  } catch (error) {
    console.error(`pnyx-axi serve: ${(error as Error).message}`)
  }

  kick()
  touchLatest({ ids: Object.keys(state.cards) })

  return {
    url,
    socket: info.socket,
    request,
    upgrade,
    async close() {
      if (closed) {
        return
      }

      await stop()
      release()
    },
  }
}

// Hook events, one JSON object per line. Null when the socket cannot be bound
// (a path too long for a Unix socket, say); hooks then spool and the watcher drains it.
async function listenIngest(
  { hydraId, onLine }: { hydraId: string; onLine: ({ line }: { line: string }) => void },
): Promise<SocketServer | null> {
  const path = socketPath({ hydraId })
  // Left by a server that did not stop cleanly; startServer already checked none is running.
  rmSync(path, { force: true })
  const server = createSocketServer(conn => {
    let buffered = ''
    conn.setEncoding('utf8')
    conn.on('data', (chunk: string) => {
      buffered += chunk

      if (buffered.length > MAX_BODY) {
        return conn.destroy()
      }

      for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
        onLine({ line: buffered.slice(0, i) })
        buffered = buffered.slice(i + 1)
      }
    })
    conn.on('end', () => {
      if (buffered.trim()) {
        onLine({ line: buffered })
      }

      conn.end()
    })
    conn.on('error', () => {})
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => resolve())
    })
  } catch {
    return null
  }

  chmodSync(path, 0o600)

  return server
}

function readBody({ req }: { req: IncomingMessage }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      text += chunk

      if (text.length > MAX_BODY) {
        reject(new HydraError({ message: 'request too large', code: 'VALIDATION_ERROR' }))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new HydraError({ message: 'request must be JSON', code: 'VALIDATION_ERROR' }))
      }
    })
    req.on('error', reject)
  })
}

type ClientMessage = { type?: unknown; id?: unknown; name?: unknown; args?: unknown }

function parseMessage({ text }: { text: string }): ClientMessage | undefined {
  try {
    const message = JSON.parse(text) as unknown

    return typeof message === 'object' && message !== null ? (message as ClientMessage) : undefined
  } catch {
    return undefined
  }
}

// Names the built web app: index.html links the content-hashed assets, so its
// hash changes with every rebuild. Empty when nothing is built (the Vite dev server).
const buildOf = ({ html }: { html: string }) => createHash('sha256').update(html)
  .digest('hex')
  .slice(0, 12)

function buildId(): string {
  try {
    return buildOf({ html: readFileSync(join(WEB_ROOT, 'index.html'), 'utf8') })
  } catch {
    return ''
  }
}

function reply({ res, status, body }: {
  res: ServerResponse
  status: number
  body: unknown
}): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

// The built web app from dist/web. A Hydra's page falls back to its index.html for any
// unknown path; the index carries the token for the WebSocket handshake, so only
// this server's own pages get it (the caller has already checked Host and Origin).
// It also carries its build, so an open tab can tell when a restarted server serves a
// newer one, and a base so the page reaches its own Hydra's WebSocket.
function serveStatic({ res, path, page }: {
  res: ServerResponse
  path: string
  page?: { token: string; identity: string; base: string }
}): void {
  const index = join(WEB_ROOT, 'index.html')
  const file = normalize(join(WEB_ROOT, path === '/' ? 'index.html' : path))
  const candidates = !file.startsWith(`${WEB_ROOT}/`) ? [] : page ? [file, index] : file === index ? [] : [file]

  for (const candidate of candidates) {
    try {
      if (candidate === index && page) {
        const raw = readFileSync(index, 'utf8')
        const html = raw.replace('</head>', `<base href="${page.base}" />\n<meta name="pnyx-token" content="${page.token}" />\n<meta name="pnyx-build" content="${buildOf({ html: raw })}" />\n<meta name="pnyx-hydra" content="${page.identity}" />\n</head>`)
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }).end(html)

        return
      }

      const body = readFileSync(candidate)
      res.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' }).end(body)

      return
    } catch {
      // Try the next candidate.
    }
  }

  reply({ res, status: 404, body: { error: 'not found; run `pnpm run build` for the web Hydra', code: 'NOT_FOUND' } })
}

function serveFlags({ args }: { args: string[] }) {
  try {
    const { values } = parseArgs({ args, options: { hydra: { type: 'string' }, port: { type: 'string' }, home: { type: 'string', multiple: true } }, strict: true })

    return values
  } catch (error) {
    throw new AxiError((error as Error).message, 'VALIDATION_ERROR', ['Run the command with --help'])
  }
}

// A fixed default keeps every Hydra at one address, so an open tab finds a restarted server again.
export { DEFAULT_PORT } from './state.ts'

export async function serve(args: string[]): Promise<Record<string, unknown>> {
  const values = serveFlags({ args })
  const hydraId = values.hydra ?? 'default'

  if (values.port !== undefined && !/^\d+$/.test(values.port)) {
    throw new AxiError('--port must be a number', 'VALIDATION_ERROR')
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port)
  let server: RunningServer

  try {
    server = await startServer({ hydraId, port, homes: values.home })
  } catch (error) {
    if (error instanceof HydraError) {
      throw new AxiError(error.message, error.code, error.help)
    }

    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new AxiError(`port ${port} is in use`, 'PORT_IN_USE', [`Stop what holds port ${port}, or pick another --port`])
    }

    throw error
  }

  // Homes given here are watched for this Hydra; a Hydra's recorded home is watched by the server itself.
  const homes = (values.home ?? []).map(path => resolveHome({ path }))
  const firstmate = homes.length > 0 ? watchHomes({ hydraId, list: homes }) : undefined
  const watching = homes.length > 0 ? `firstmate: ${JSON.stringify(`watching ${homes.length} home${homes.length === 1 ? '' : 's'}`)}\n` : ''
  const skipped = Object.entries(server.skipped).map(([id, reason]) => `skipped: ${JSON.stringify(`Hydra ${id}: ${reason}`)}\n`)
    .join('')
  process.stdout.write(`server: running\nhydra: ${hydraId}\nurl: ${JSON.stringify(server.url)}\n${watching}${skipped}help[1]: Run \`pnyx-axi stop\` to stop it\n`)
  await new Promise(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  const watched = firstmate?.close()
  await server.close()

  return { server: 'stopped', ...(watched ? { firstmate: watched } : {}) }
}

export async function stop(args: string[]): Promise<Record<string, unknown>> {
  if (args.length > 0) {
    throw new AxiError(`unexpected argument: ${args[0]}`, 'VALIDATION_ERROR', ['Run `pnyx-axi stop`; it stops the one server of every Hydra'])
  }

  // Usually one process; a server an older version started for a single Hydra is stopped too.
  const running = async () => {
    const found = await Promise.all(hydraIds().map(hydraId => readServer({ hydraId })))

    return [...new Set(found.flatMap(info => info ? [info.pid] : []))]
  }

  const pids = await running()

  if (pids.length === 0) {
    return { server: 'none: not running', help: ['Run `pnyx-axi serve` to start it'] }
  }

  for (const pid of pids) {
    process.kill(pid, 'SIGTERM')
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS

  for (let left = pids; left.length > 0; left = await running()) {
    if (Date.now() > deadline) {
      throw new AxiError(`server pid ${left.join(', ')} did not stop`, 'TIMEOUT', [`Check process ${left.join(', ')}`])
    }

    await new Promise(r => setTimeout(r, 25))
  }

  return { server: 'stopped' }
}
