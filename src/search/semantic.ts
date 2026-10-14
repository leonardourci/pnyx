// Semantic search on top of the full-text index: the worker client, the hybrid
// ranking and `search setup --semantic`. Only used when the search.semantic
// setting is on; with it off, search is lexical exactly as before.
// Ranking: the full-text query as typed (every word must match) and an exact
// nearest-vector scan each give up to 50 cards; reciprocal rank fusion (k = 60)
// merges them, card id breaking ties. With the reranker on, it re-scores the top
// 20 against each card's nearest chunk; its score marks weak results and says
// when nothing matched strongly.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { constants, setPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pnyxHome } from '../store/board-store.ts'
import { SemanticError, detectMode, loadBackend } from './backend.ts'
import { search, updateIndex, type Hit, type Match, type Query } from './index.ts'
import { EMBEDDERS, RERANKER, download, modelPath, type EmbedderId, type ModelFile } from './models.ts'
import { readSettings, saveSettings, stubbed, type SearchSettings } from './settings.ts'
import { nearestCards, vectorCounts, type Nearest, type VectorRead } from './vectors.ts'
import type { Request } from './worker.ts'

const CANDIDATES = 50
const RRF_K = 60
const RERANK_TOP = 20
// Reranker scores, measured at 100k chunks: under WEAK a result is marked weak,
// and when even the best is under STRONG the output says no strong match.
// ponytail: constants from one measured corpus; tune them on real boards.
const WEAK = 0.5
const STRONG = 0.9
const SNIPPET_MAX = 200
// The first query after a spawn waits for the model to load.
const EMBED_TIMEOUT_MS = 30_000
const RERANK_TIMEOUT_MS = 30_000
const STATUS_TIMEOUT_MS = 30_000
const INDEX_TIMEOUT_MS = 10_000
const RESPAWN_MS = 1_000

// One per Pnyx home. Named after a hash of the home, in the temp folder, so a
// long home path cannot push it past the 104-byte socket path limit.
export function workerSocket(): string {
  const name = `pnyx-semantic-${createHash('sha256').update(pnyxHome())
    .digest('hex')
    .slice(0, 16)}`

  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
}

const workerPath = join(import.meta.dirname, import.meta.url.endsWith('.ts') ? 'worker.ts' : 'worker.js')

// Starts a detached worker at utility QoS on macOS (efficiency cores, full GPU
// speed) or below-normal priority elsewhere. Its output goes to semantic.log.
function spawnWorker(): void {
  mkdirSync(pnyxHome(), { recursive: true })
  const log = openSync(join(pnyxHome(), 'semantic.log'), 'w')
  const options = { detached: true, stdio: ['ignore', log, log] as ['ignore', number, number], env: process.env }
  const qos = process.platform === 'darwin' && existsSync('/usr/sbin/taskpolicy')
  const child = qos ? spawn('/usr/sbin/taskpolicy', ['-c', 'utility', process.execPath, workerPath], options) : spawn(process.execPath, [workerPath], options)
  child.on('error', () => {})

  if (!qos && child.pid) {
    try {
      setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // Lowering priority is best effort.
    }
  }

  child.unref()
  closeSync(log)
}

type Reply = Record<string, unknown> & { error?: string; code?: string }

function once(req: Request, ms: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(workerSocket())
    let buf = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new SemanticError('the semantic worker did not answer in time'))
    }, ms)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`))
    socket.on('data', data => (buf += data))
    socket.on('end', () => {
      clearTimeout(timer)

      try {
        resolve(JSON.parse(buf) as Reply)
      } catch {
        // A worker shutting down closes without answering; the caller retries.
        reject(Object.assign(new Error('the semantic worker closed without an answer'), { code: 'ECONNRESET' }))
      }
    })
    socket.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

// Sends one request to the worker, starting one when none listens.
async function request(req: Request, timeoutMs: number): Promise<Reply> {
  const deadline = Date.now() + timeoutMs
  let spawned = 0

  for (;;) {
    const left = deadline - Date.now()

    if (left <= 0) {
      throw new SemanticError('the semantic worker did not start; see semantic.log in the Pnyx home')
    }

    try {
      const reply = await once(req, left)

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

    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function ask(req: Request, timeoutMs: number): Promise<Reply> {
  const reply = await request(req, timeoutMs)

  if (reply.error) {
    throw new SemanticError(reply.error)
  }

  return reply
}

export interface HybridHit extends Omit<Hit, 'match'> {
  // Which leg found the card: words (lexical, or fuzzy for typos), meaning (semantic) or both.
  match: Match | 'semantic' | 'both'
  weak?: true
}

export interface SearchResult {
  hits: HybridHit[]
  total: number
  mode: string
  // Present only when semantic search is on: ready, indexing or unavailable.
  semantic?: string
  note?: string
}

const describe = (key: string) => key.replace(/@[^/]*\//, ' on ')

const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}…` : flat
}

// Search as the settings say: lexical when semantic search is off or --card is
// given, hybrid otherwise, falling back to lexical (and saying so) when the
// worker cannot answer.
export async function searchBoard(
  board: string,
  query: Query,
  settings: SearchSettings = readSettings(),
): Promise<SearchResult> {
  updateIndex(board)

  if (!settings.semantic || query.card) {
    const r = search(board, query)

    return { hits: r.hits, total: r.total, mode: r.match }
  }

  const lexical = search(board, { ...query, limit: Math.max(query.limit, CANDIDATES) })
  let vectors: VectorRead
  let key: string

  try {
    await ask({ op: 'index', board }, INDEX_TIMEOUT_MS)
    const reply = await ask({ op: 'embed', text: query.text }, EMBED_TIMEOUT_MS)
    key = reply.key as string
    const filters = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.workspace ? { workspace: query.workspace } : {}),
    }
    const vector = Float32Array.from(reply.vector as number[])
    vectors = nearestCards(board, key, vector, filters, CANDIDATES)
  } catch (error) {
    return { hits: lexical.hits.slice(0, query.limit), total: lexical.total, mode: lexical.match, semantic: `unavailable: ${(error as Error).message}` }
  }

  const score = new Map<string, number>()
  const add = (card: string, rank: number) =>
    score.set(card, (score.get(card) ?? 0) + 1 / (RRF_K + rank + 1))
  lexical.hits.forEach((h, i) => add(h.card, i))
  vectors.nearest.forEach((n, i) => add(n.card, i))
  let order = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([card]) => card)
  const byWords = new Map(lexical.hits.map(h => [h.card, h]))
  const byMeaning = new Map<string, Nearest>(vectors.nearest.map(n => [n.card, n]))

  let semantic = vectors.embedded >= vectors.total ? `ready: ${describe(key)}` : `indexing: ${vectors.embedded} of ${vectors.total} entries embedded with ${describe(key)}; the rest match by words only`
  let note: string | undefined
  const weak = new Set<string>()
  let mode = 'hybrid'

  if (settings.rerank && order.length) {
    const top = order.slice(0, RERANK_TOP)
    const docs = top.map(c => byMeaning.get(c)?.body ?? byWords.get(c)!.snippets.map(s => s.snippet.replace(/[[\]]/g, '')).join('\n'))

    try {
      const scores = (await ask({ op: 'rerank', query: query.text, docs }, RERANK_TIMEOUT_MS)).scores as number[]
      const ranked = top
        .map((card, i) => ({ card, s: scores[i]!, i }))
        .sort((a, b) => b.s - a.s || a.i - b.i)

      for (const r of ranked) {
        if (r.s < WEAK) {
          weak.add(r.card)
        }
      }

      if (ranked[0]!.s < STRONG) {
        note = 'no strong match: the results below are the nearest, but none clearly answers the query'
      }

      order = [...ranked.map(r => r.card), ...order.slice(RERANK_TOP)]
      mode = 'hybrid, reranked'
    } catch (error) {
      semantic += `; reranker unavailable: ${(error as Error).message}`
    }
  }

  const hits = order.slice(0, query.limit).map((card): HybridHit => {
    const words = byWords.get(card)
    const near = byMeaning.get(card)
    const hit: HybridHit = words
      ? { ...words, match: near ? 'both' : words.match }
      : { card, title: near!.title, match: 'semantic', snippets: [{ kind: near!.kind, at: near!.at || 'unknown', snippet: excerpt(near!.body) }] }

    return weak.has(card) ? { ...hit, weak: true } : hit
  })

  // Every card is somewhere in the vector order, so only word matches count toward more results.
  // ponytail: no similarity floor for meaning-only cards without the reranker; add one per model once measured on real boards.
  const total = Math.max(lexical.total, hits.length)

  return { hits, total, mode, semantic, ...(note ? { note } : {}) }
}

export interface SemanticStatus {
  semantic: string
  rerank?: string
  vectors?: string
}

// What semantic search is doing on this machine: off, or the active mode and
// model and how many of the board's entries have vectors.
export async function semanticStatus(board: string): Promise<SemanticStatus> {
  const s = readSettings()

  if (!s.semantic) {
    return { semantic: 'off: run `pnyx-axi search setup --semantic` to turn it on' }
  }

  try {
    const reply = await ask({ op: 'status' }, STATUS_TIMEOUT_MS)
    const key = reply.key as string
    const v = vectorCounts(board, key)

    return {
      semantic: `on: ${describe(key)}, ${reply.dims as number} dimensions`,
      rerank: s.rerank ? 'on' : 'off',
      ...(v ? { vectors: `${v.embedded} of ${v.total} entries embedded` } : {}),
    }
  } catch (error) {
    return { semantic: `unavailable: ${(error as Error).message}`, rerank: s.rerank ? 'on' : 'off' }
  }
}

export interface SetupFile {
  file: string
  bytes: number
  status: 'present' | 'downloaded' | 'stub'
}

// Detects the mode, downloads what it needs (the 311m embedder and the reranker
// with a GPU, the 97m embedder alone on CPU, unless overridden), checks each model
// against its golden values, then turns semantic search on and starts embedding the board.
export async function setupSemantic(
  board: string,
  options: { model?: EmbedderId; rerank?: boolean },
  progress: (line: string) => void,
): Promise<{ mode: string; settings: SearchSettings; files: SetupFile[] }> {
  const mode = await detectMode()
  const model = options.model ?? (mode === 'cpu' ? 'granite-97m' : 'granite-311m')
  const rerank = options.rerank ?? mode !== 'cpu'
  const wanted: ModelFile[] = [EMBEDDERS[model], ...(rerank ? [RERANKER] : [])]
  const files: SetupFile[] = []

  for (const m of wanted) {
    if (stubbed()) {
      files.push({ file: m.file, bytes: m.bytes, status: 'stub' })
      continue
    }

    progress(`${m.file}: ${(m.bytes / 1e6).toFixed(0)} MB`)
    let shown = 0
    const status = await download(m, bytes => {
      const tenth = Math.floor((bytes / m.bytes) * 10)

      if (tenth > shown) {
        progress(`${m.file}: ${(shown = tenth) * 10}%`)
      }
    })
    files.push({ file: m.file, bytes: m.bytes, status })
  }

  try {
    const backend = await loadBackend(model)

    try {
      if (rerank) {
        await backend.rerank('probe', ['probe'])
      }
    } finally {
      await backend.close()
    }
  } catch (error) {
    // A file that fails its golden check is deleted, so running setup again downloads it afresh.
    if (error instanceof SemanticError && error.broken) {
      rmSync(modelPath(error.broken), { force: true })
    }

    throw error
  }

  const settings = { semantic: true, rerank, model }
  saveSettings(settings)
  updateIndex(board)
  await ask({ op: 'index', board }, INDEX_TIMEOUT_MS).catch(() => undefined)

  return { mode, settings, files }
}
