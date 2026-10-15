import { AxiError } from 'axi-sdk-js'
import { findCard } from '../core/decide.ts'
import { HydraError } from '../core/model.ts'
import { COMMON, guard, parse, type Options, type Output } from '../cli/commands.ts'
import { loadHydra } from '../store/hydra-store.ts'
import { SYNONYMS, SYNONYMS_VERSION } from './synonyms.ts'
import { KINDS, SNIPPETS, indexStatus, rebuildIndex, type IndexResult, type Kind } from './index.ts'
import { EMBEDDER_IDS } from './models.ts'
import { runtimeInstalled } from './runtime.ts'
import { queryOracle, semanticStatus, setupSemantic, type OracleResult } from './semantic.ts'
import { SETTING_KEYS, readSettings, settingEntries, writeSetting } from './settings.ts'

const LIMIT = 20
const MAX = 100

const SEARCH: Options = {
  ...COMMON,
  kind: { type: 'string' },
  card: { type: 'string' },
  workspace: { type: 'string' },
  limit: { type: 'string' },
}

const SETUP: Options = { ...COMMON, semantic: { type: 'boolean' } }

async function axi<T>({ work }: { work: Promise<T> }): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof HydraError) {
      throw new AxiError(error.message, error.code, error.help)
    }

    throw error
  }
}

async function status({ hydraId }: { hydraId: string }): Promise<Output> {
  const s = indexStatus({ hydraId })
  const seq = loadHydra({ hydraId }).state.seq

  if (!s) {
    return {
      index: 'none: not built yet',
      help: ['Run `pnyx-axi oracle "<words>"` or `pnyx-axi oracle rebuild` to build it'],
    }
  }

  if (!s.current) {
    return { index: 'stale: built by another version; the next search rebuilds it', bytes: s.bytes }
  }

  return {
    index: s.builtThrough === seq ? `current through seq ${seq}` : `behind: through seq ${s.builtThrough} of ${seq}; the next search catches up`,
    mode: readSettings({ }).semantic && runtimeInstalled() ? 'hybrid: words fused with meaning' : 'lexical, fuzzy when nothing matches',
    synonyms: `v${SYNONYMS_VERSION}, ${SYNONYMS.length} groups`,
    ...(await semanticStatus({ hydraId })),
    docs: s.docs,
    transcripts: s.transcripts,
    bytes: s.bytes,
  }
}

function built({ result }: { result: IndexResult }): Output {
  return { rebuilt: result, help: ['Run `pnyx-axi oracle "<words>"`'] }
}

async function setup({ args }: { args: string[] }): Promise<Output> {
  const { values, hydraId } = parse({ args, options: SETUP, positionals: 0 })

  if (!values.semantic) {
    throw new AxiError('oracle setup needs --semantic', 'VALIDATION_ERROR', ['Run `pnyx-axi oracle setup --semantic`'])
  }

  const progress = ({ line }: { line: string }) => {
    if (process.stderr.isTTY) {
      process.stderr.write(`${line}\n`)
    }
  }

  const r = await setupSemantic({ hydraId, progress })

  return {
    semantic: 'on',
    mode: r.mode,
    model: r.choice.model,
    rerank: r.choice.rerank ? 'on' : 'off',
    files: r.files,
    help: ['Run `pnyx-axi oracle "<words>"`; entries are embedded in the background', 'Run `pnyx-axi settings set oracle.semantic off` to turn it off'],
  }
}

const oracleCommand = guard<Output | Promise<Output>>({
  handler: ({ args }) => {
    if (args[0] === 'status' || args[0] === 'rebuild') {
      const { hydraId } = parse({ args: args.slice(1), options: COMMON, positionals: 0 })

      return args[0] === 'status' ? axi({ work: status({ hydraId }) }) : built({ result: rebuildIndex({ hydraId }) })
    }

    if (args[0] === 'setup') {
      return axi({ work: setup({ args: args.slice(1) }) })
    }

    const { values, positionals, hydraId } = parse({ args, options: SEARCH, positionals: Infinity })
    const text = positionals.join(' ')

    if (!text) {
      throw new AxiError('missing query', 'VALIDATION_ERROR', ['Run `pnyx-axi oracle "<words>"`'])
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
      : findCard({ state: loadHydra({ hydraId }).state, ref: values.card as string }).id

    return axi({
      work: queryOracle({
        hydraId,
        query: {
          text,
          limit: Math.min(rawLimit ? Number(rawLimit) : LIMIT, MAX),
          ...(kind ? { kind: kind as Kind } : {}),
          ...(card ? { card } : {}),
          ...(values.workspace ? { workspace: values.workspace as string } : {}),
        },
      })
        .then(result => present({ input: result, text, card, kind })),
    })
  },
})

function present(
  { input: { hits, total, mode, semantic, note }, text, card, kind }: {
    input: OracleResult
    text: string
    card: string | undefined
    kind: string | undefined
  },
): Output {
  const head: Output = { mode, ...(semantic ? { semantic } : {}), ...(note ? { note } : {}) }

  if (hits.length === 0) {
    return {
      ...head,
      results: `none: no matches for ${JSON.stringify(text)}`,
      help: [card || kind ? 'Every word must match in one entry; try fewer words or a prefix like `deplo*`' : 'Every word must match on one card; try fewer words or a prefix like `deplo*`'],
    }
  }

  const help = card ? [`Run \`pnyx-axi history --card ${card}\` for its events`] : [hits[0]!.kind === 'hydra' ? 'Open Hydra on the Hydra to read this conversation' : `Run \`pnyx-axi card ${hits[0]!.card}\` to open the top match`]
  const shown = card ? hits[0]!.snippets.length : hits.length

  if (total > shown) {
    help.push(`${total - shown} more ${card ? 'matches' : 'matching cards'}; raise --limit (max ${MAX}) or narrow with --kind, --card or --workspace`)
  }

  return { ...head, results: hits, help }
}

const settingsCommand = guard({
  handler: ({ args }) => {
    if (args[0] === 'set') {
      const { positionals } = parse({ args: args.slice(1), options: {}, positionals: 2 })

      if (positionals.length !== 2) {
        throw new AxiError('settings set needs a key and a value', 'VALIDATION_ERROR', [`Keys: ${SETTING_KEYS.join(', ')}`])
      }

      return {
        settings: settingEntries({
          settings: writeSetting({
            key: positionals[0]!,
            value: positionals[1]!,
          }),
        }),
      }
    }

    parse({ args, options: {}, positionals: 0 })

    return { settings: settingEntries({ settings: readSettings({ }) }), help: ['Run `pnyx-axi settings set oracle.semantic on|off`'] }
  },
})

export const oracleCommands = { oracle: oracleCommand, settings: settingsCommand }

export const ORACLE_HELP = `usage: pnyx-axi oracle "<words>" [--kind event|note|transcript] [--card <id>] [--workspace <name>] [--limit <n>]
       pnyx-axi oracle status | rebuild [--hydra <name>]
       pnyx-axi oracle setup --semantic
Full-text search over card titles, links, event text, harvested notes and the session transcripts
hooks recorded. Every word must match somewhere on one card: its title, link titles or any entry.
With --card or --kind, every word must match in one entry of that card or kind. Words match by
stem, ignoring case and accents ("deploying" finds "deploy", "migracao" finds "migração"), and with
their synonyms:
${SYNONYMS.map(g => g.join(' / ')).join(', ')}. When nothing matches, words also match the
indexed words nearest them, so typos and partial words still find results (mode: fuzzy).
End a word with * to match a prefix; \`oracle -- status\` searches for that word.
Results are ranked by BM25, best first, one per card with its ${SNIPPETS} best-matching entries as
snippets (with --card, its matching entries up to --limit); ${LIMIT} cards by default (max ${MAX}).
A harvested note (a summary, decision or context; see \`pnyx-axi harvest\`) counts double.
Each search first indexes what the log and transcripts gained. The index, search.db in the Hydra's
folder, is a derived cache: \`oracle rebuild\` deletes and rebuilds it from the log and transcripts,
after harvesting every card's transcript.
Tool calls and output, thinking and injected text are not indexed; secret-shaped strings are redacted.
Semantic search is on by default: searches also find cards by meaning, in any language (match:
semantic, or both), fused with the word matches by rank. It runs local, pinned Apache-2.0 models
through the optional node-llama-cpp and sqlite-vec packages: with a GPU (Metal, CUDA or Vulkan)
granite-embedding-311m and the Qwen3-Reranker-0.6B reranker, about 1 GB; on CPU only,
granite-embedding-97m without the reranker, about 115 MB. The first search downloads them in the
background into the Pnyx home's models/ folder, checked by SHA-256 and golden vectors; searches are
full-text and say so until they are ready (\`oracle status\` shows the progress). \`oracle setup
--semantic\` downloads what the settings need now instead, in the foreground. A background
worker process embeds entries at low priority and exits after a minute idle. The reranker re-scores
the top 20, marks weak results and says when nothing matches strongly. A card found by meaning
alone is weak outside the reranked top 20, or without the reranker, when its nearest entry is under
the model's similarity floor.
Turn it off with \`pnyx-axi settings set oracle.semantic off\` (or PNYX_SEMANTIC=off for one
process); installed without optional dependencies, search is full-text only.
`

export const SETTINGS_HELP = `usage: pnyx-axi settings
       pnyx-axi settings set <key> <value>
This machine's search settings, in the Pnyx home's settings.json, shared by every Hydra:
  oracle.semantic on|off        Find cards by meaning as well as by words (default on)
  oracle.rerank auto|on|off     Re-score the top results with the reranker, about 0.4 s a search
                                on a GPU (auto: on with a GPU, off on CPU only)
  oracle.model auto|${EMBEDDER_IDS.join('|')}  The embedding model (auto: granite-311m with a GPU,
                                granite-97m on CPU only)
A model the settings need is downloaded on the next search.
`
