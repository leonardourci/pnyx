import { readSearchFilters } from './filters.ts'
import { AxiError } from 'axi-sdk-js'
import { findCard } from '#tasks/push-rules.ts'
import { findProject } from '#projects/read.ts'
import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import { COMMON, guard, parse, type Options, type Output } from '#app/cli-support.ts'
import { loadHydra } from '#app/store.ts'
import { SYNONYMS } from './synonyms.ts'
import { KINDS, type Hit, type Kind, type Match } from './model.ts'
import { SNIPPETS } from './search.ts'
import { searchInBackground } from './search-background.ts'

const LIMIT = 20
const MAX = 100

const SEARCH: Options = {
  ...COMMON,
  kind: { type: 'string' },
  card: { type: 'string' },
  workspace: { type: 'string' },
  column: {
    type: 'string',
    multiple: true,
  },
  project: {
    type: 'string',
    multiple: true,
  },
  since: { type: 'string' },
  limit: { type: 'string' },
}

// Pnyx tasks record a project by its path and Firstmate tasks by its name, so a filter
// matches both the value given and the attached project it names.
function projectRefs({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): string[] {
  try {
    const { path } = findProject({
      state,
      ref,
    })

    return path === ref ? [ref] : [
      ref,
      path,
    ]
  } catch (error) {
    if (error instanceof HydraError && error.code === 'NOT_FOUND') {
      return [ref]
    }

    throw error
  }
}

const oracleCommand = guard({
  handler: async ({ args }) => {
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

    const state = loadHydra({ hydraId }).state
    const card = values.card === undefined
      ? undefined
      : findCard({
        state,
        ref: values.card as string,
      }).id
    const projects = (values.project as string[] | undefined)?.flatMap(ref => projectRefs({
      state,
      ref,
    }))

    return present({
      input: await searchInBackground({
        hydraId,
        query: {
          ...readSearchFilters({
            value: JSON.stringify({
              columns: values.column,
              projects,
              since: values.since,
            }),
          }),
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
    help.push(`${total - shown} more ${card ? 'matches' : 'matching cards'}; raise --limit (max ${MAX}) or narrow with --kind, --card, --workspace, --column, --project or --since`)
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

export const ORACLE_HELP = `usage: pnyx-axi oracle "<words>" [--kind event|note|transcript] [--card <id>] [--workspace <name>] [--column <id>] [--project <name|path>] [--since <date>] [--limit <n>]
Search tasks, events and recorded transcripts. The first query reads history into a derived SQLite cache;
later queries read only what is new.
Search includes saved briefs, intents, owner asks, reports and helper results, including earlier versions.
Column, project and date filters apply before the result limit; repeat --column or --project for alternatives.
Every word must match somewhere on one card. With --card or --kind every word must match one entry.
Words ignore case and accents and match word forms (plurals, -ed, -ing), synonyms and prefixes (*).
Synonyms: ${SYNONYMS.map(group => group.join(' / ')).join(', ')}.
When nothing matches, similar words are tried (mode: fuzzy).
Results rank by the query words in a card's title, project and link titles, then by its best entry
(notes count double), then by latest activity.
Each card shows its ${SNIPPETS} best entries; --card shows matching entries up to --limit.
The default limit is ${LIMIT}, capped at ${MAX}. Tool output, thinking and injected text are excluded;
secret-shaped strings are redacted. \`task report <task>\` reads the latest stored report.
`
