// Semantic search on top of the full-text index: the worker client, the hybrid
// ranking and `oracle setup --semantic`. On by default; with the oracle.semantic
// setting off, or the optional packages not installed, search is lexical exactly as before.
// Ranking: the full-text query as typed (every word must match) and an exact
// nearest-vector scan each give up to 50 cards; reciprocal rank fusion (k = 60)
// merges them, card id breaking ties. With the reranker on, it re-scores the top
// 20 against each card's nearest chunk; its score marks weak results and says
// when nothing matched strongly. A card found by meaning alone is weak unless the
// reranker kept it in its top 20, or, without the reranker, unless its nearest
// chunk reaches the model's similarity floor.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { constants, setPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { HydraError } from '../core/model.ts'
import { loadHydra, pnyxHome } from '../store/hydra-store.ts'
import { localToken } from '../server/state.ts'
import { SemanticError, detectMode, loadBackend, resolveChoice, type Choice } from './backend.ts'
import { search, updateIndex, type Hit, type Match, type Query } from './index.ts'
import { EMBEDDERS, RERANKER, activeFailure, clearFailure, download, modelPath, type ModelFile } from './models.ts'
import { runtimeInstalled } from './runtime.ts'
import { readSettings, saveSettings, stubbed, type OracleSettings } from './settings.ts'
import { nearestCards, nearestChunks, vectorCounts, type NearChunk, type Nearest, type VectorRead } from './vectors.ts'
import type { Request } from './worker.ts'

const CANDIDATES = 50
const RRF_K = 60
const RERANK_TOP = 20
// Reranker scores, measured at 100k chunks: under WEAK a result is marked weak,
// and when even the best is under STRONG the output says no strong match.
// ponytail: constants from one measured corpus; tune them on real hydras.
const WEAK = 0.5
const STRONG = 0.9
const SNIPPET_MAX = 200
// The first query after a spawn waits for the model to load.
const EMBED_TIMEOUT_MS = 30_000
const RERANK_TIMEOUT_MS = 30_000
const STATUS_TIMEOUT_MS = 30_000
const INDEX_TIMEOUT_MS = 10_000
const RESPAWN_MS = 1_000

const hash = ({ text }: { text: string }) => createHash('sha256').update(text)
  .digest('hex')
  .slice(
    0,
    16,
  )

// One per Pnyx home, named after a hash of the home so a long home path cannot
// push it past the 104-byte socket path limit. It sits in a folder in the temp
// folder that only this user can use, so another user cannot listen in its place.
// A Windows pipe cannot live in a folder; its name also hashes the private write token.
export function workerSocket(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pnyx-semantic-${hash({ text: `${pnyxHome()}\n${localToken()}` })}`
  }

  const uid = process.getuid!()
  const dir = join(
    tmpdir(),
    `pnyx-${uid}`,
  )
  mkdirSync(
    dir,
    {
      recursive: true,
      mode: 0o700,
    },
  )
  const s = lstatSync(dir)

  if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o077) !== 0) {
    throw new SemanticError({ message: `${dir} must be a folder only this user can use; remove it` })
  }

  return join(
    dir,
    `semantic-${hash({ text: pnyxHome() })}.sock`,
  )
}

const workerPath = join(
  import.meta.dirname,
  import.meta.url.endsWith('.ts') ? 'worker.ts' : 'worker.js',
)

// Starts a detached worker at utility QoS on macOS (efficiency cores, full GPU
// speed) or below-normal priority elsewhere. Its output goes to semantic.log.
function spawnWorker(): void {
  mkdirSync(
    pnyxHome(),
    { recursive: true },
  )
  const log = openSync(
    join(
      pnyxHome(),
      'semantic.log',
    ),
    'w',
  )
  const options = {
    detached: true,
    stdio: [
      'ignore',
      log,
      log,
    ] as ['ignore', number, number],
    env: process.env,
  }
  const qos = process.platform === 'darwin' && existsSync('/usr/sbin/taskpolicy')
  const child = qos ? spawn(
    '/usr/sbin/taskpolicy',
    [
      '-c',
      'utility',
      process.execPath,
      workerPath,
    ],
    options,
  ) : spawn(
    process.execPath,
    [workerPath],
    options,
  )
  child.on(
    'error',
    () => {},
  )

  if (!qos && child.pid) {
    try {
      setPriority(
        child.pid,
        constants.priority.PRIORITY_BELOW_NORMAL,
      )
    } catch {
      // Lowering priority is best effort.
    }
  }

  child.unref()
  closeSync(log)
}

type Reply = Record<string, unknown> & {
  error?: string
  code?: string
}

function once({
  req,
  ms,
}: {
  req: Request
  ms: number
}): Promise<Reply> {
  return new Promise((
    resolve,
    reject,
  ) => {
    const socket = createConnection(workerSocket())
    let buf = ''
    const timer = setTimeout(
      () => {
        socket.destroy()
        reject(new SemanticError({ message: 'the semantic worker did not answer in time' }))
      },
      ms,
    )
    socket.setEncoding('utf8')
    socket.on(
      'connect',
      () => socket.write(`${JSON.stringify(req)}\n`),
    )
    socket.on(
      'data',
      data => (buf += data),
    )
    socket.on(
      'end',
      () => {
        clearTimeout(timer)

        try {
          resolve(JSON.parse(buf) as Reply)
        } catch {
        // A worker shutting down closes without answering; the caller retries.
          reject(Object.assign(
            new Error('the semantic worker closed without an answer'),
            { code: 'ECONNRESET' },
          ))
        }
      },
    )
    socket.on(
      'error',
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function request({
  req,
  timeoutMs,
}: {
  req: Request
  timeoutMs: number
}): Promise<Reply> {
  const deadline = Date.now() + timeoutMs
  let spawned = 0

  for (;;) {
    const left = deadline - Date.now()

    if (left <= 0) {
      throw new SemanticError({ message: 'the semantic worker did not start; see semantic.log in the Pnyx home' })
    }

    try {
      const reply = await once({
        req,
        ms: left,
      })

      if (reply.code !== 'RESTART') {
        return reply
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ECONNRESET') {
        throw error
      }

      // A worker that is shutting down may still hold the socket; start another once it is gone.
      if (Date.now() - spawned > RESPAWN_MS) {
        spawnWorker()
        spawned = Date.now()
      }
    }

    await new Promise(resolve => setTimeout(
      resolve,
      100,
    ))
  }
}

async function ask({
  req,
  timeoutMs,
}: {
  req: Request
  timeoutMs: number
}): Promise<Reply> {
  const reply = await request({
    req,
    timeoutMs,
  })

  if (reply.error) {
    throw new SemanticError({ message: reply.error })
  }

  return reply
}

export interface HybridHit extends Omit<Hit, 'match'> {
  // Which leg found the card: words (lexical, or fuzzy for typos), meaning (semantic) or both.
  match: Match | 'semantic' | 'both'
  weak?: true
}

export interface OracleResult {
  hits: HybridHit[]
  total: number
  mode: string
  // Present only when semantic search runs: ready, indexing, preparing or unavailable.
  semantic?: string
  note?: string
}

type Phase = {
  phase: string
  done?: number
  total?: number
  message?: string
}

const describe = ({ key }: { key: string }) => key.replace(
  /@[^/]*\//,
  ' on ',
)

function phaseText({
  what,
  p,
}: {
  what: string
  p: Phase
}): string {
  if (p.phase === 'downloading') {
    return `downloading the ${what}, ${Math.floor(((p.done ?? 0) / (p.total ?? 1)) * 100)}% of ${((p.total ?? 0) / 1e6).toFixed(0)} MB`
  }

  return p.phase === 'failed' ? `the ${what} failed: ${p.message ?? 'unknown error'}` : `${p.phase === 'loading' ? 'loading' : p.phase} the ${what}`
}

const excerpt = ({ text }: { text: string }) => {
  const flat = text.replace(
    /\s+/g,
    ' ',
  ).trim()

  return flat.length > SNIPPET_MAX ? `${flat.slice(
    0,
    SNIPPET_MAX,
  )}…` : flat
}

const strip = ({ snippet }: { snippet: string }) => snippet.replace(
  /[[\]]/g,
  '',
)

// Reciprocal rank fusion of ranked lists of ids, best first, ties by id.
function fuse<T extends string | number>({ lists }: { lists: T[][] }): T[] {
  const score = new Map<T, number>()

  for (const list of lists) {
    list.forEach((
      id,
      rank,
    ) => score.set(
      id,
      (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1),
    ))
  }

  return [...score].sort((
    a,
    b,
  ) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id)
}

interface Reranked<T> {
  order: T[]
  weak: Set<T>
  note?: string
  failed?: string
}

// Re-scores the top results with the reranker; on failure keeps the fused order.
async function rerank<T>({
  order,
  text,
  query,
}: {
  order: T[]
  text: (
    { id }: {
      id: T
    },
  ) => string
  query: string
}): Promise<Reranked<T>> {
  const top = order.slice(
    0,
    RERANK_TOP,
  )

  try {
    const scores = (await ask({
      req: {
        op: 'rerank',
        query,
        docs: top.map(id => text({ id })),
      },
      timeoutMs: RERANK_TIMEOUT_MS,
    })).scores as number[]
    const ranked = top
      .map((
        id,
        i,
      ) => ({
        id,
        s: scores[i]!,
        i,
      }))
      .sort((
        a,
        b,
      ) => b.s - a.s || a.i - b.i)
    const weak = new Set(ranked.filter(r => r.s < WEAK).map(r => r.id))
    const note = ranked[0]!.s < STRONG ? 'no strong match: the results below are the nearest, but none clearly answers the query' : undefined

    const reordered = [
      ...ranked.map(r => r.id),
      ...order.slice(RERANK_TOP),
    ]

    return {
      order: reordered,
      weak,
      ...(note ? { note } : {}),
    }
  } catch (error) {
    return {
      order,
      weak: new Set(),
      failed: (error as Error).message,
    }
  }
}

// Oracle as the settings say. Hybrid when semantic search is on and its optional
// packages are installed; full-text exactly as before when it is off or they are
// absent. When the worker cannot answer yet (models downloading or loading) or has
// failed, full-text results come back with a line saying why.
export async function queryOracle(
  {
    hydraId,
    query,
    settings = readSettings({ }),
  }: {
    hydraId: string
    query: Query
    settings?: OracleSettings
  },
): Promise<OracleResult> {
  updateIndex({ hydraId })

  const lexicalOnly = ({ semantic }: { semantic?: string } = {}): OracleResult => {
    const r = search({
      hydraId,
      query,
    })

    return {
      hits: r.hits,
      total: r.total,
      mode: r.match,
      ...(semantic ? { semantic } : {}),
    }
  }

  if (!settings.semantic || !(stubbed() || runtimeInstalled())) {
    return lexicalOnly({ })
  }

  const failure = activeFailure({ })

  if (failure) {
    return lexicalOnly({ semantic: `unavailable: ${failure}; run \`pnyx-axi oracle setup --semantic\` to retry now` })
  }

  let reply: Reply

  try {
    await ask({
      req: {
        op: 'index',
        hydraId,
      },
      timeoutMs: INDEX_TIMEOUT_MS,
    })
    reply = await ask({
      req: {
        op: 'embed',
        text: query.text,
      },
      timeoutMs: EMBED_TIMEOUT_MS,
    })
  } catch (error) {
    return lexicalOnly({ semantic: `unavailable: ${(error as Error).message}` })
  }

  if (reply.code === 'NOT_READY') {
    return lexicalOnly({
      semantic: `${phaseText({
        what: 'model',
        p: reply.embedder as Phase,
      })}; full-text results until it is ready`,
    })
  }

  const key = reply.key as string
  const vector = Float32Array.from(reply.vector as number[])
  const reranker = reply.reranker as Phase
  const pendingReranker = reranker.phase === 'downloading' || reranker.phase === 'loading' ? `; ${phaseText({
    what: 'reranker',
    p: reranker,
  })}` : ''

  const floor = reply.floor as number
  const leg: Leg = {
    key,
    floor,
    vector,
    useReranker: reply.rerank === true,
    pendingReranker,
  }

  return query.card ? await cardSearch({
    hydraId,
    query,
    leg,
  }) : await hydraSearch({
    hydraId,
    query,
    leg,
  })
}

// The query's vector and how to rank with it.
interface Leg {
  key: string
  floor: number
  vector: Float32Array
  useReranker: boolean
  // A status suffix while the reranker is still downloading or loading.
  pendingReranker: string
}

function readiness({
  key,
  v,
}: {
  key: string
  v: {
    embedded: number
    total: number
  }
}): string {
  return v.embedded >= v.total
    ? `ready: ${describe({ key })}`
    : `indexing: ${v.embedded} of ${v.total} entries embedded with ${describe({ key })}; the rest match by words only`
}

async function hydraSearch({
  hydraId,
  query,
  leg,
}: {
  hydraId: string
  query: Query
  leg: Leg
}): Promise<OracleResult> {
  const {
    key,
    floor,
    vector,
    useReranker,
    pendingReranker,
  } = leg
  const lexical = search({
    hydraId,
    query: {
      ...query,
      limit: Math.max(
        query.limit,
        CANDIDATES,
      ),
    },
  })
  const filters = {
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.live ? { live: true } : {}),
    ...(query.workspace ? { workspace: query.workspace } : {}),
  }
  const vectors: VectorRead = nearestCards({
    hydraId,
    key,
    query: vector,
    filters,
    limit: CANDIDATES,
  })
  const byWords = new Map(lexical.hits.map(h => [
    h.card,
    h,
  ]))
  const byMeaning = new Map<string, Nearest>(vectors.nearest.map(n => [
    n.card,
    n,
  ]))
  let order = fuse({
    lists: [
      lexical.hits.map(h => h.card),
      vectors.nearest.map(n => n.card),
    ],
  })
  let semantic = readiness({
    key,
    v: vectors,
  }) + pendingReranker
  let ranked: Reranked<string> = {
    order,
    weak: new Set(),
  }
  let mode = 'hybrid'

  if (useReranker && order.length) {
    ranked = await rerank({
      order,
      text: ({ id: c }) => byMeaning.get(c)?.body ?? byWords.get(c)!.snippets.map(s => strip({ snippet: s.snippet })).join('\n'),
      query: query.text,
    })
    order = ranked.order

    if (ranked.failed) {
      semantic += `; reranker unavailable: ${ranked.failed}`
    } else {
      mode = 'hybrid, reranked'
    }
  }

  const reranked = useReranker && !ranked.failed
  const top = new Set(order.slice(
    0,
    RERANK_TOP,
  ))
  const hits = order.slice(
    0,
    query.limit,
  ).map((card): HybridHit => {
    const words = byWords.get(card)
    const near = byMeaning.get(card)
    const hit: HybridHit = words
      ? {
        ...words,
        match: near ? 'both' : words.match,
      }
      : {
        card,
        title: near!.title,
        ...(card === '$board' ? { kind: 'hydra' as const } : {}),
        match: 'semantic',
        snippets: [
          {
            kind: near!.kind,
            at: near!.at || 'unknown',
            snippet: excerpt({ text: near!.body }),
          },
        ],
      }
    const weakMeaning = !words && (reranked ? !top.has(card) : near!.similarity < floor)

    return ranked.weak.has(card) || weakMeaning ? {
      ...hit,
      weak: true,
    } : hit
  })

  // Every card is somewhere in the vector order, so only word matches count toward more results.
  const total = Math.max(
    lexical.total,
    hits.length,
  )

  return {
    hits,
    total,
    mode,
    semantic,
    ...(ranked.note ? { note: ranked.note } : {}),
  }
}

// One card's entries (--card): its full-text matching entries fused with its
// entries nearest the query, as one hit whose snippets are the best entries.
async function cardSearch({
  hydraId,
  query,
  leg,
}: {
  hydraId: string
  query: Query
  leg: Leg
}): Promise<OracleResult> {
  const {
    key,
    vector,
    useReranker,
    pendingReranker,
  } = leg
  const card = query.card!
  const limit = Math.max(
    query.limit,
    CANDIDATES,
  )
  const lexical = search({
    hydraId,
    query: {
      ...query,
      limit,
      withIds: true,
    },
  }).hits[0]
  const words = new Map((lexical?.snippets ?? []).map(s => [
    s.id!,
    s,
  ]))
  const near = nearestChunks({
    hydraId,
    key,
    query: vector,
    card,
    kind: query.kind,
    limit: CANDIDATES,
  })
  const meaning = new Map<number, NearChunk>(near.map(n => [
    n.id,
    n,
  ]))
  let order = fuse({
    lists: [
      [...words.keys()],
      near.map(n => n.id),
    ],
  })
  const counts = vectorCounts({
    hydraId,
    key,
  }) ?? {
    embedded: 0,
    total: 0,
  }
  let semantic = readiness({
    key,
    v: counts,
  }) + pendingReranker
  let ranked: Reranked<number> = {
    order,
    weak: new Set(),
  }
  let mode = 'hybrid'

  if (useReranker && order.length) {
    const text = ({ id }: {
      id: number
    }) =>
      meaning.get(id)?.body ?? strip({
        snippet: words.get(id)!.snippet,
      })
    ranked = await rerank({
      order,
      text,
      query: query.text,
    })
    order = ranked.order

    if (ranked.failed) {
      semantic += `; reranker unavailable: ${ranked.failed}`
    } else {
      mode = 'hybrid, reranked'
    }
  }

  if (!order.length) {
    return {
      hits: [],
      total: 0,
      mode,
      semantic,
    }
  }

  const snippets = order.slice(
    0,
    query.limit,
  ).map(id => {
    const w = words.get(id)

    if (w) {
      return {
        kind: w.kind,
        at: w.at,
        snippet: w.snippet,
      }
    }

    const n = meaning.get(id)!

    return {
      kind: n.kind,
      at: n.at || 'unknown',
      snippet: excerpt({ text: n.body }),
    }
  })
  const match = words.size && near.length ? 'both' : words.size ? lexical!.match : 'semantic'
  const title = lexical?.title ?? loadHydra({ hydraId }).state.cards[card]?.title ?? card

  const hits: HybridHit[] = [
    {
      card,
      title,
      match,
      snippets,
    },
  ]

  const total = order.length

  return {
    hits,
    total,
    mode,
    semantic,
    ...(ranked.note ? { note: ranked.note } : {}),
  }
}

export interface SemanticStatus {
  semantic: string
  rerank?: string
  vectors?: string
}

export async function semanticStatus({ hydraId }: { hydraId: string }): Promise<SemanticStatus> {
  const s = readSettings({ })

  if (!s.semantic) {
    return { semantic: 'off: run `pnyx-axi settings set oracle.semantic on` to turn it on' }
  }

  if (!stubbed() && !runtimeInstalled()) {
    return { semantic: 'not installed: pnyx-axi was installed without its optional dependencies (node-llama-cpp, sqlite-vec); search is full-text' }
  }

  const failure = activeFailure({ })

  if (failure) {
    return { semantic: `unavailable: ${failure}; run \`pnyx-axi oracle setup --semantic\` to retry now` }
  }

  try {
    const reply = await ask({
      req: { op: 'status' },
      timeoutMs: STATUS_TIMEOUT_MS,
    })
    const embedder = reply.embedder as Phase
    const reranker = reply.reranker as Phase
    const rerank = reranker.phase === 'ready' ? 'on' : reranker.phase === 'off' ? 'off' : phaseText({
      what: 'reranker',
      p: reranker,
    })

    if (embedder.phase !== 'ready') {
      return {
        semantic: `preparing (${reply.mode as string || 'detecting'}): ${phaseText({
          what: 'model',
          p: embedder,
        })}; full-text results until it is ready`,
      }
    }

    const key = reply.key as string
    const v = vectorCounts({
      hydraId,
      key,
    })

    return {
      semantic: `on: ${describe({ key })}, ${reply.dims as number} dimensions`,
      rerank,
      ...(v ? { vectors: `${v.embedded} of ${v.total} entries embedded` } : {}),
    }
  } catch (error) {
    return { semantic: `unavailable: ${(error as Error).message}` }
  }
}

export interface SetupFile {
  file: string
  bytes: number
  status: 'present' | 'downloaded' | 'stub'
}

export async function setupSemantic(
  {
    hydraId,
    progress,
  }: {
    hydraId: string
    progress: ({ line }: { line: string }) => void
  },
): Promise<{
  mode: string
  choice: Choice
  files: SetupFile[]
}> {
  if (!stubbed() && !runtimeInstalled()) {
    throw new HydraError({
      message: 'semantic search needs the optional dependencies node-llama-cpp and sqlite-vec, which this install skipped',
      code: 'NOT_INSTALLED',
      help: ['Run `pnpm install` in the pnyx clone to add them back'],
    })
  }

  clearFailure()
  const settings: OracleSettings = {
    ...readSettings({ applyEnv: false }),
    semantic: true,
  }
  const mode = await detectMode()
  const choice = resolveChoice({
    settings,
    mode,
  })
  const wanted: ModelFile[] = [
    EMBEDDERS[choice.model],
    ...(choice.rerank ? [RERANKER] : []),
  ]
  const files: SetupFile[] = []

  for (const m of wanted) {
    if (stubbed()) {
      files.push({
        file: m.file,
        bytes: m.bytes,
        status: 'stub',
      })
      continue
    }

    progress({ line: `${m.file}: ${(m.bytes / 1e6).toFixed(0)} MB` })
    let shown = 0
    const status = await download({
      model: m,
      progress: ({ bytes }) => {
        const tenth = Math.floor((bytes / m.bytes) * 10)

        if (tenth > shown) {
          progress({ line: `${m.file}: ${(shown = tenth) * 10}%` })
        }
      },
    })
    files.push({
      file: m.file,
      bytes: m.bytes,
      status,
    })
  }

  try {
    const backend = await loadBackend({ model: choice.model })

    try {
      if (choice.rerank) {
        await backend.rerank({
          query: 'probe',
          docs: ['probe'],
        })
      }
    } finally {
      await backend.close()
    }
  } catch (error) {
    // A file that fails its golden check is deleted, so running setup again downloads it afresh.
    if (error instanceof SemanticError && error.broken) {
      rmSync(
        modelPath({ model: error.broken }),
        { force: true },
      )
    }

    throw error
  }

  saveSettings({ settings })
  updateIndex({ hydraId })
  await ask({
    req: {
      op: 'index',
      hydraId,
    },
    timeoutMs: INDEX_TIMEOUT_MS,
  }).catch(() => undefined)

  return {
    mode,
    choice,
    files,
  }
}

export async function matchActions({
  query,
  entries,
  settings = readSettings({}),
}: {
  query: string
  entries: {
    id: string
    text: string
  }[]
  settings?: OracleSettings
}): Promise<string[]> {
  if (!settings.semantic || !(stubbed() || runtimeInstalled()) || activeFailure({})) {
    return []
  }

  try {
    const result = await ask({
      req: {
        op: 'commands',
        query,
        docs: entries.map(entry => entry.text),
      },
      timeoutMs: EMBED_TIMEOUT_MS,
    })

    if (result.code === 'NOT_READY') {
      return []
    }

    const scores = result.scores as number[]
    const floor = result.floor as number

    return entries.map((
      entry,
      index,
    ) => ({
      id: entry.id,
      score: scores[index] ?? 0,
    }))
      .filter(entry => entry.score >= floor)
      .sort((
        a,
        b,
      ) => b.score - a.score)
      .map(entry => entry.id)
  } catch {
    return []
  }
}
