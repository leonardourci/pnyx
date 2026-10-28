import { AxiError } from 'axi-sdk-js'
import { findCard } from '../tasks/push-rules.ts'
import { COMMON, guard, parse, type Options, type Output } from '../app/cli-support.ts'
import { loadHydra } from '../app/store.ts'
import { SYNONYMS, SYNONYMS_VERSION } from './synonyms.ts'
import { KINDS, SNIPPETS, indexStatus, rebuildIndex, search, updateIndex, type Hit, type IndexResult, type Kind, type Match } from './index.ts'

const LIMIT = 20
const MAX = 100

const SEARCH: Options = {
  ...COMMON,
  kind: { type: 'string' },
  card: { type: 'string' },
  workspace: { type: 'string' },
  limit: { type: 'string' },
}

function status({ hydraId }: { hydraId: string }): Output {
  const s = indexStatus({ hydraId })
  const seq = loadHydra({ hydraId }).state.seq

  if (!s) {
    return {
      index: 'none: not built yet',
      help: ['Run `pnyx-axi oracle "<words>"` or `pnyx-axi oracle rebuild` to build it'],
    }
  }

  if (!s.current) {
    return {
      index: 'stale: built by another version; the next search rebuilds it',
      bytes: s.bytes,
    }
  }

  return {
    index: s.builtThrough === seq ? `current through seq ${seq}` : `behind: through seq ${s.builtThrough} of ${seq}; the next search catches up`,
    synonyms: `v${SYNONYMS_VERSION}, ${SYNONYMS.length} groups`,
    docs: s.docs,
    transcripts: s.transcripts,
    bytes: s.bytes,
  }
}

function built({ result }: { result: IndexResult }): Output {
  return {
    rebuilt: result,
    help: ['Run `pnyx-axi oracle "<words>"`'],
  }
}

const oracleCommand = guard({
  handler: ({ args }) => {
    if (args[0] === 'status' || args[0] === 'rebuild') {
      const { hydraId } = parse({
        args: args.slice(1),
        options: COMMON,
        positionals: 0,
      })

      return args[0] === 'status' ? status({ hydraId }) : built({ result: rebuildIndex({ hydraId }) })
    }

    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: SEARCH,
      positionals: Infinity,
    })
    const text = positionals.join(' ')

    if (!text) {
      throw new AxiError(
        'missing query',
        'VALIDATION_ERROR',
        ['Run `pnyx-axi oracle "<words>"`'],
      )
    }

    const kind = values.kind as string | undefined

    if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
      throw new AxiError(
        `unknown kind: ${kind}`,
        'VALIDATION_ERROR',
        [`Use one of ${KINDS.join(', ')}`],
      )
    }

    const rawLimit = values.limit as string | undefined

    if (rawLimit !== undefined && !/^[1-9]\d*$/.test(rawLimit)) {
      throw new AxiError(
        '--limit must be a positive integer',
        'VALIDATION_ERROR',
      )
    }

    const card = values.card === undefined
      ? undefined
      : findCard({
        state: loadHydra({ hydraId }).state,
        ref: values.card as string,
      }).id

    updateIndex({ hydraId })

    return present({
      input: search({
        hydraId,
        query: {
          text,
          limit: Math.min(
            rawLimit ? Number(rawLimit) : LIMIT,
            MAX,
          ),
          ...(kind ? { kind: kind as Kind } : {}),
          ...(card ? { card } : {}),
          ...(values.workspace ? { workspace: values.workspace as string } : {}),
        },
      }),
      text,
      card,
      kind,
    })
  },
})

function present(
  {
    input: {
      hits,
      total,
      match,
    },
    text,
    card,
    kind,
  }: {
    input: {
      hits: Hit[]
      total: number
      match: Match
    }
    text: string
    card: string | undefined
    kind: string | undefined
  },
): Output {
  const head: Output = { mode: match }

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

  return {
    ...head,
    results: hits,
    help,
  }
}

export const oracleCommands = {
  oracle: oracleCommand,
}

export const ORACLE_HELP = `usage: pnyx-axi oracle "<words>" [--kind event|note|transcript] [--card <id>] [--workspace <name>] [--limit <n>]
       pnyx-axi oracle status | rebuild [--hydra <name>]
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
`
