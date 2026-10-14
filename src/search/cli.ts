// pnyx-axi search: full-text and, when turned on, semantic search over a board's
// history, plus `search status|rebuild|setup` and the `settings` command.
import { AxiError } from 'axi-sdk-js'
import { findCard } from '../core/decide.ts'
import { BoardError } from '../core/model.ts'
import { COMMON, guard, parse, type Options, type Output } from '../cli/commands.ts'
import { loadBoard } from '../store/board-store.ts'
import { SYNONYMS, SYNONYMS_VERSION } from './synonyms.ts'
import { KINDS, SNIPPETS, indexStatus, rebuildIndex, type IndexResult, type Kind } from './index.ts'
import { EMBEDDER_IDS, type EmbedderId } from './models.ts'
import { searchBoard, semanticStatus, setupSemantic, type SearchResult } from './semantic.ts'
import { SETTING_KEYS, readSettings, settingEntries, writeSetting } from './settings.ts'

const LIMIT = 20
const MAX = 100

const SEARCH: Options = {
  ...COMMON,
  kind: { type: 'string' },
  card: { type: 'string' },
  workspace: { type: 'string' },
  limit: { type: 'string' },
  lexical: { type: 'boolean' },
}

const SETUP: Options = { ...COMMON, semantic: { type: 'boolean' }, model: { type: 'string' }, rerank: { type: 'boolean' }, 'no-rerank': { type: 'boolean' } }

// A rejected promise carries a BoardError the way guard() converts a thrown one.
async function axi<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof BoardError) {
      throw new AxiError(error.message, error.code, error.help)
    }

    throw error
  }
}

async function status(board: string): Promise<Output> {
  const s = indexStatus(board)
  const seq = loadBoard(board).state.seq

  if (!s) {
    return {
      index: 'none: not built yet',
      help: ['Run `pnyx-axi search "<words>"` or `pnyx-axi search rebuild` to build it'],
    }
  }

  if (!s.current) {
    return { index: 'stale: built by another version; the next search rebuilds it', bytes: s.bytes }
  }

  return {
    index: s.builtThrough === seq ? `current through seq ${seq}` : `behind: through seq ${s.builtThrough} of ${seq}; the next search catches up`,
    mode: readSettings().semantic ? 'hybrid: words fused with meaning' : 'lexical, fuzzy when nothing matches',
    synonyms: `v${SYNONYMS_VERSION}, ${SYNONYMS.length} groups`,
    ...(await semanticStatus(board)),
    docs: s.docs,
    transcripts: s.transcripts,
    bytes: s.bytes,
  }
}

function built(result: IndexResult): Output {
  return { rebuilt: result, help: ['Run `pnyx-axi search "<words>"`'] }
}

async function setup(args: string[]): Promise<Output> {
  const { values, board } = parse(args, SETUP, 0)

  if (!values.semantic) {
    throw new AxiError('search setup needs --semantic', 'VALIDATION_ERROR', ['Run `pnyx-axi search setup --semantic`'])
  }

  const model = values.model as string | undefined

  if (model !== undefined && !EMBEDDER_IDS.includes(model as EmbedderId)) {
    throw new AxiError(`--model takes ${EMBEDDER_IDS.join(' or ')}`, 'VALIDATION_ERROR')
  }

  if (values.rerank && values['no-rerank']) {
    throw new AxiError('use --rerank or --no-rerank, not both', 'VALIDATION_ERROR')
  }

  const rerank = values.rerank ? true : values['no-rerank'] ? false : undefined

  // Download progress goes to stderr, and only to a terminal.
  const progress = (line: string) => {
    if (process.stderr.isTTY) {
      process.stderr.write(`${line}\n`)
    }
  }

  const options = {
    ...(model ? { model: model as EmbedderId } : {}),
    ...(rerank === undefined ? {} : { rerank }),
  }
  const r = await setupSemantic(board, options, progress)

  return {
    semantic: 'on',
    mode: r.mode,
    model: r.settings.model,
    rerank: r.settings.rerank ? 'on' : 'off',
    files: r.files,
    help: ['Run `pnyx-axi search "<words>"`; entries are embedded in the background', 'Run `pnyx-axi settings set search.semantic off` to turn it off'],
  }
}

const searchCommand = guard<Output | Promise<Output>>(args => {
  if (args[0] === 'status' || args[0] === 'rebuild') {
    const { board } = parse(args.slice(1), COMMON, 0)

    return args[0] === 'status' ? axi(status(board)) : built(rebuildIndex(board))
  }

  if (args[0] === 'setup') {
    return axi(setup(args.slice(1)))
  }

  // Unquoted words are one query.
  const { values, positionals, board } = parse(args, SEARCH, Infinity)
  const text = positionals.join(' ')

  if (!text) {
    throw new AxiError('missing query', 'VALIDATION_ERROR', ['Run `pnyx-axi search "<words>"`'])
  }

  const kind = values.kind as string | undefined

  if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
    throw new AxiError(`unknown kind: ${kind}`, 'VALIDATION_ERROR', [`Use one of ${KINDS.join(', ')}`])
  }

  const rawLimit = values.limit as string | undefined

  if (rawLimit !== undefined && !/^[1-9]\d*$/.test(rawLimit)) {
    throw new AxiError('--limit must be a positive integer', 'VALIDATION_ERROR')
  }

  const card = values.card === undefined
    ? undefined
    : findCard(loadBoard(board).state, values.card as string).id
  const settings = readSettings()

  return axi(searchBoard(board, {
    text,
    limit: Math.min(rawLimit ? Number(rawLimit) : LIMIT, MAX),
    ...(kind ? { kind: kind as Kind } : {}),
    ...(card ? { card } : {}),
    ...(values.workspace ? { workspace: values.workspace as string } : {}),
  }, values.lexical ? { ...settings, semantic: false } : settings)
    .then(result => present(result, text, card, kind)))
})

function present(
  { hits, total, mode, semantic, note }: SearchResult,
  text: string,
  card: string | undefined,
  kind: string | undefined,
): Output {
  const head: Output = { mode, ...(semantic ? { semantic } : {}), ...(note ? { note } : {}) }

  if (hits.length === 0) {
    return {
      ...head,
      results: `none: no matches for ${JSON.stringify(text)}`,
      help: [card || kind ? 'Every word must match in one entry; try fewer words or a prefix like `deplo*`' : 'Every word must match on one card; try fewer words or a prefix like `deplo*`'],
    }
  }

  const help = card ? [`Run \`pnyx-axi history --card ${card}\` for its events`] : [`Run \`pnyx-axi card ${hits[0]!.card}\` to open the top match`]
  const shown = card ? hits[0]!.snippets.length : hits.length

  if (total > shown) {
    help.push(`${total - shown} more ${card ? 'matches' : 'matching cards'}; raise --limit (max ${MAX}) or narrow with --kind, --card or --workspace`)
  }

  return { ...head, results: hits, help }
}

// pnyx-axi settings [set <key> <value>]: this machine's search settings.
const settingsCommand = guard(args => {
  if (args[0] === 'set') {
    const { positionals } = parse(args.slice(1), {}, 2)

    if (positionals.length !== 2) {
      throw new AxiError('settings set needs a key and a value', 'VALIDATION_ERROR', [`Keys: ${SETTING_KEYS.join(', ')}`])
    }

    return { settings: settingEntries(writeSetting(positionals[0]!, positionals[1]!)) }
  }

  parse(args, {}, 0)

  return { settings: settingEntries(readSettings()), help: ['Run `pnyx-axi settings set search.semantic on|off`'] }
})

export const searchCommands = { search: searchCommand, settings: settingsCommand }

export const SEARCH_HELP = `usage: pnyx-axi search "<words>" [--kind event|note|transcript] [--card <id>] [--workspace <name>] [--limit <n>] [--lexical]
       pnyx-axi search status | rebuild [--board <name>]
       pnyx-axi search setup --semantic [--model ${EMBEDDER_IDS.join('|')}] [--rerank | --no-rerank]
Full-text search over card titles, links, event text, harvested notes and the session transcripts
hooks recorded. Every word must match somewhere on one card: its title, link titles or any entry.
With --card or --kind, every word must match in one entry of that card or kind. Words match by
stem, ignoring case and accents ("deploying" finds "deploy", "migracao" finds "migração"), and with
their synonyms:
${SYNONYMS.map(g => g.join(' / ')).join(', ')}. When nothing matches, words also match the
indexed words nearest them, so typos and partial words still find results (mode: fuzzy).
End a word with * to match a prefix; \`search -- status\` searches for that word.
Results are ranked by BM25, best first, one per card with its ${SNIPPETS} best-matching entries as
snippets (with --card, its matching entries up to --limit); ${LIMIT} cards by default (max ${MAX}).
A harvested note (a summary, decision or context; see \`pnyx-axi harvest\`) counts double.
Each search first indexes what the log and transcripts gained. The index, search.db in the board's
folder, is a derived cache: \`search rebuild\` deletes and rebuilds it from the log and transcripts,
after harvesting every card's transcript.
Tool calls and output, thinking and injected text are not indexed; secret-shaped strings are redacted.
Semantic search is off until \`search setup --semantic\`, which installs node-llama-cpp and sqlite-vec with
npm into the Pnyx home's runtime/ folder, downloads pinned, Apache-2.0 models into its models/ folder (checked by SHA-256 and golden vectors) and turns it on: with a GPU
(Metal, CUDA or Vulkan) granite-embedding-311m and the Qwen3-Reranker-0.6B reranker, about 1 GB;
on CPU only, granite-embedding-97m without the reranker, about 115 MB. Then searches also find cards
by meaning, in any language (match: semantic, or both), fused with the word matches; --lexical skips
that for one search, and --card is always lexical. The reranker re-scores the top 20, marks weak
results and says when nothing matches strongly. A background worker process embeds entries at low
priority and exits after a minute idle; \`search status\` shows the mode and progress.
Turn either off with \`pnyx-axi settings set search.semantic off\` or \`search.rerank off\`.
`

export const SETTINGS_HELP = `usage: pnyx-axi settings
       pnyx-axi settings set <key> <value>
This machine's search settings, in the Pnyx home's settings.json, shared by every board:
  search.semantic on|off   Find cards by meaning as well as by words (needs \`search setup --semantic\`)
  search.rerank on|off     Re-score the top results with the reranker (about 0.4 s a search on a GPU)
  search.model ${EMBEDDER_IDS.join('|')}  The embedding model; granite-97m suits a CPU-only machine
Turning on a setting whose model or runtime is not installed is refused.
`
