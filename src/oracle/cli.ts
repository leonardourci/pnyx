import { projectsFor } from '#projects/read.ts'
import { readSearchFilters } from './filters.ts'
import { findCard } from '#tasks/push-rules.ts'
import type { HydraProject } from '#projects/model.ts'
import { findProject } from '#projects/read.ts'
import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import { COMMON, guard, parse, type Options, type Output } from '#app/cli-support.ts'
import { loadHydra, requireHydra } from '#app/store.ts'
import { KINDS, type Hit, type Kind, type Match } from './model.ts'
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

function projectRefs({
  state,
  ref,
  projects,
}: {
  projects: HydraProject[]
  state: HydraState
  ref: string
}): string[] {
  try {
    const { path } = findProject({
      state,
      ref,
      projects,
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
      throw new HydraError({
        message: 'missing query',
        code: 'VALIDATION_ERROR',
        help: ['Run `pnyx oracle "<words>"`'],
      })
    }

    const kind = values.kind as string | undefined

    if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
      throw new HydraError({
        message: `unknown kind: ${kind}`,
        code: 'VALIDATION_ERROR',
        help: [`Use one of ${KINDS.join(', ')}`],
      })
    }

    const rawLimit = values.limit as string | undefined

    if (rawLimit !== undefined && !/^[1-9]\d*$/.test(rawLimit)) {
      throw new HydraError({
        message: '--limit must be a positive integer',
        code: 'VALIDATION_ERROR',
      })
    }

    requireHydra({ hydraId })

    const state = loadHydra({ hydraId }).state
    const card = values.card === undefined
      ? undefined
      : findCard({
        state,
        ref: values.card as string,
      }).id
    const visibleProjects = values.project === undefined ? [] : projectsFor({ state })
    const projects = (values.project as string[] | undefined)?.flatMap(ref => projectRefs({
      state,
      ref,
      projects: visibleProjects,
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

  const help = ['Open the matched Hydra or task in the UI to read its conversation']
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
