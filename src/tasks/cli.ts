import { existsSync } from 'node:fs'
import { readInput } from '#app/request-context.ts'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AxiError } from 'axi-sdk-js'
import type { Column } from './columns-model.ts'
import type { HydraState, HydraEvent } from '#app/model.ts'
import { projectsFor } from '#projects/read.ts'
import { MAX_BRIEF_LENGTH, type Card } from './model.ts'
import { clip, guard, parse, COMMON, WRITE, meta, required, commit, HISTORY_MAX, summarize, integer, TEXT_CUT, type Output } from '#app/cli-support.ts'
import { canonical } from '#store/paths.ts'
import { loadHydra } from '#app/store.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { liveTask, rankOf } from './select.ts'
import { socketPath } from '#app/server-state.ts'
import { decidePush } from './push.ts'
import { reminderTime } from './time.ts'
import { HydraError } from '#store/errors.ts'
import { findCard } from './push-rules.ts'
import { taskSessions } from '#workers/cli.ts'
import { tagsTask } from './updates.ts'
import { movedHistory, type HistoryEntry } from './move-history.ts'
import { columnRule } from './column-defaults.ts'
import { decideView } from '#preferences/decisions.ts'
import { columnByRef, lockedColumn, LOCKED_DELETE, validateColumns } from './column-rules.ts'
import { parseColumnRule } from './columns.ts'
import { lifecycleMoves } from './lifecycle.ts'
import { answerPrompt } from '#workers/answers.ts'
import { decideMove } from './columns-decisions.ts'
import { requestCwd } from '#app/request-context.ts'
import { workerIdentity } from '#workers/worker-identity.ts'

const INTENT_LIMIT = 4000

function column({ value }: { value: string }): Column {
  return (value.startsWith('custom:') ? value : value.replace(
    /-/g,
    '_',
  )) as Column
}

// A task records an attached project by path; rows show its name, and every row has the field
// so lists stay tabular.
function projectName({
  state,
  project,
}: {
  state: HydraState
  project?: string | null
}): string {
  return project ? projectsFor({ state }).find(p => p.path === project)?.name ?? project : 'none'
}

export function attentionLabel({ card }: { card: Card }) {
  const kinds = card.attention.map(a => a.kind)

  return kinds.length > 0 ? kinds.join(' ') : 'none'
}

export function cardRow({
  state,
  card,
}: {
  state: HydraState
  card: Card
}) {
  return {
    id: card.id,
    title: card.title,
    project: projectName({
      state,
      project: card.project,
    }),
    column: card.column,
  }
}

function cardDetail({
  state,
  card,
  full,
}: {
  state: HydraState
  card: Card
  full: boolean
}): Output {
  const detail: Output = {
    id: card.id,
    key: card.key,
    title: card.title,
    project: projectName({
      state,
      project: card.project,
    }),
    workspace: card.workspace,
    column: card.column,
    tags: card.tags.length ? card.tags : 'none',
  }

  if (card.brief !== undefined) {
    detail.brief = full ? card.brief : clip({ text: card.brief })
  }

  if (card.parentId) {
    detail.parent = card.parentId
  }

  if (card.activity) {
    detail.activity = card.activity
  }

  if (card.agent) {
    detail.agent = card.agent
  }

  detail.sessions = card.sessionIds?.length ? card.sessionIds : 'none'
  detail.visibility = card.hidden ? 'history' : 'hydra'
  detail.hideAfterHours = card.doneAfterHours ?? 'shared setting'

  if (card.settings) {
    detail.settings = card.settings
  }

  detail.permissions = card.permissions?.length ? card.permissions : 'none'
  detail.attention = card.attention.length ? card.attention : 'none'
  detail.links = card.links.length
    ? card.links.map(l => ({
      kind: l.kind,
      number: l.number ?? '',
      title: l.title ?? '',
      state: l.state ?? 'unknown',
      url: l.url,
    }))
    : 'none'

  if (card.outcome) {
    detail.outcome = card.outcome
  }

  if (card.replies?.length) {
    detail.replies = card.replies
  }

  detail.revision = card.revision
  detail.updated = card.updatedAt

  return detail
}

export const CONTEXT_TASKS = 5

// The session-start hook's summary: the Hydra's open work for the attached project holding the
// session's folder, kept short because it loads into every session there. Elsewhere it prints nothing.
export const context = guard({
  handler: ({ args }) => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        cwd: { type: 'string' },
      },
      positionals: 0,
    })
    const folder = canonical({ path: String(values.cwd ?? requestCwd()) })
    const { state } = loadHydra({ hydraId })
    const project = folder ? projectsFor({ state }).find(p => !p.detached
      && (folder === p.path || folder.startsWith(`${p.path}/`))) : undefined

    if (!project) {
      return {}
    }

    const done = new Set(hydraConfig({ state }).columns.filter(c => c.role === 'done').map(c => c.id))
    const open = Object.values(state.cards).filter(card => liveTask({ card })
      && card.project === project.path && !done.has(card.column))
      .sort((
        a,
        b,
      ) => rankOf({ card: a }) - rankOf({ card: b }))
    // The server's socket file, not a health request: the hook never waits on the network.
    const server = existsSync(socketPath({ hydraId }))

    return {
      pnyx: `Hydra ${hydraId}, project ${project.name}, server ${server ? 'running' : 'not running'}`,
      count: `${Math.min(
        open.length,
        CONTEXT_TASKS,
      )} of ${open.length} open tasks`,
      tasks: open.length ? open.slice(
        0,
        CONTEXT_TASKS,
      ).map(card => ({
        id: card.id,
        title: card.title,
        column: card.column,
      })) : 'none: no open tasks for this project',
      help: [
        `Run \`pnyx-axi task list --hydra ${hydraId}\` for every task`,
        `Run \`pnyx-axi card <id> --hydra ${hydraId}\` for one task`,
      ],
    }
  },
})

export const push = guard({
  handler: ({ args }) => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...WRITE,
        key: { type: 'string' },
        file: { type: 'string' },
      },
      positionals: 0,
    })
    const m = meta({ values })
    const key = required({
      value: values.key as string | undefined,
      what: '--key',
    })
    const file = required({
      value: values.file as string | undefined,
      what: '--file',
    })
    let input: unknown

    try {
      input = JSON.parse(readInput({ file: file }))
    } catch (error) {
      throw new AxiError(
        `cannot read card JSON from ${file}: ${(error as Error).message}`,
        'VALIDATION_ERROR',
      )
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.pushed',
        card: key,
      },
      decide: ({ state }) => decidePush({
        state,
        key,
        input,
        meta: m,
      }),
    })
  },
})

// A paused worker's --until takes the same times as a reminder.
export function untilTime({
  until,
  now,
}: {
  until?: string
  now: string
}): string | undefined {
  if (until === undefined) {
    return undefined
  }

  return reminderTime({
    when: until,
    now,
  })
}

export const TASK_FIELDS = [
  'attention',
  'parent',
  'status',
  'worker',
  'hold',
  'queue',
] as const

export type TaskField = (typeof TASK_FIELDS)[number]

// `task list --fields status,worker` adds those fields to the default id, title, project and column.
export function taskFields({ value }: { value?: string }): TaskField[] {
  const fields = (value ?? '').split(',').map(field => field.trim())
    .filter(Boolean)
  const unknown = fields.filter(field => !TASK_FIELDS.includes(field as TaskField))

  if (unknown.length) {
    throw new AxiError(
      `unknown field: ${unknown.join(', ')}`,
      'VALIDATION_ERROR',
      [`Use --fields with any of ${TASK_FIELDS.join(', ')}`],
    )
  }

  return fields as TaskField[]
}

export type TaskCreated = Extract<HydraEvent, { type: 'task.created' }>

export function taskBrief({ value }: { value: unknown }): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.length > MAX_BRIEF_LENGTH) {
    throw new HydraError({
      message: `a brief must be text of up to ${MAX_BRIEF_LENGTH} characters`,
      code: 'VALIDATION_ERROR',
    })
  }

  return value
}

export function taskIntent({ value }: { value: unknown }): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || !value.trim() || value.length > INTENT_LIMIT) {
    throw new HydraError({
      message: `an intent must be text of 1 to ${INTENT_LIMIT} characters`,
      code: 'VALIDATION_ERROR',
    })
  }

  return value.trim()
}

export function taskHistory({
  hydraId,
  ref,
  before,
  limit,
  full,
}: {
  hydraId: string
  ref: string
  before?: string
  limit: number
  full: boolean
}): Output {
  if (limit < 1 || limit > HISTORY_MAX) {
    throw new HydraError({
      message: `limit must be 1–${HISTORY_MAX}`,
      code: 'VALIDATION_ERROR',
    })
  }

  const state = loadHydra({ hydraId }).state
  const task = findCard({
    state,
    ref,
  })
  const ids = new Set([
    task.id,
    ...Object.values(state.cards).filter(c => c.parentId === task.id)
      .map(c => c.id),
  ])
  const sessions = taskSessions({
    hydraId,
    ids,
  })
  const history = movedHistory({
    hydraId,
    task: task.id,
    cards: [...ids],
    matches: ({ event: e }) => ids.has(e.cardId) || (e.type === 'task.session' && (ids.has(e.data.before ?? '') || ids.has(e.data.after ?? ''))) || tagsTask({
      event: e,
      ids,
    }),
  })
  const matches = history.slice(historyStart({
    history,
    hydraId,
    before,
  }))
  const page = matches.slice(
    0,
    limit,
  )
  const moved = history.some(entry => entry.hydra !== hydraId)
  const last = page.at(-1)
  const more = matches.length > limit
  const help: string[] = []
  const out: Output = {
    hydraId,
    task: task.id,
    sessions: sessions.size ? [...sessions].map(id => ({
      session: id,
      transcript: state.sessions?.[id]?.agent.transcriptPath ?? 'unavailable',
      command: `pnyx-axi task chat ${task.id} --session ${id} --hydra ${hydraId}`,
    })) : 'none: no agent has worked on this task',
    events: page.length ? page.map(entry => historyRow({
      entry,
      moved,
      full,
    })) : 'none: no matching events',
  }

  if (more && last) {
    // A cursor on this Hydra stays a plain seq; one on an earlier Hydra names it.
    const next = last.hydra === hydraId ? last.event.seq : `${last.hydra}:${last.event.seq}`
    out.next = next
    help.push(`Run \`pnyx-axi task history ${ref} --before ${next} --hydra ${hydraId}\` for older events`)
  }

  if (!full && page.length) {
    help.push(`Run \`pnyx-axi task history ${ref} --full --hydra ${hydraId}\` for each event's data`)
  }

  if (help.length) {
    out.help = help
  }

  return out
}

// Only a moved task's rows name their Hydra, so every other history keeps its columns.
function historyRow({
  entry,
  moved,
  full,
}: {
  entry: HistoryEntry
  moved: boolean
  full: boolean
}): Output {
  const { event } = entry
  const row: Output = {}

  if (moved) {
    row.hydra = entry.hydra
  }

  Object.assign(
    row,
    {
      seq: event.seq,
      id: event.id,
      at: event.at,
      type: event.type,
      card: event.cardId,
      actor: event.actor,
      summary: summarize({ event }),
    },
  )

  if (full) {
    Object.assign(
      row,
      {
        data: event.data,
        reason: event.reason,
        details: event.details,
      },
    )
  }

  return row
}

// --before takes a seq on this Hydra, or <hydra>:<seq> for the events a moved task had on an earlier Hydra.
function historyStart({
  history,
  hydraId,
  before,
}: {
  history: HistoryEntry[]
  hydraId: string
  before?: string
}): number {
  if (before === undefined) {
    return 0
  }

  const [
    hydra,
    seq,
  ] = before.includes(':') ? before.split(
    ':',
    2,
  ) : [
    hydraId,
    before,
  ]
  const at = Number(seq)

  if (!/^\d+$/.test(seq ?? '') || !Number.isSafeInteger(at)) {
    throw new HydraError({
      message: '--before takes a seq or <hydra>:<seq>',
      code: 'VALIDATION_ERROR',
    })
  }

  // The cursor names the last row shown, so paging continues right after it, even into another Hydra's rows.
  const shown = history.findIndex(entry => entry.hydra === hydra && entry.event.seq === at)

  if (shown !== -1) {
    return shown + 1
  }

  const index = history.findIndex(entry => entry.hydra === hydra && entry.event.seq < at)

  return index === -1 ? history.length : index
}

function columnCommand({ args }: { args: string[] }): Output {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      title: { type: 'string' },
      description: { type: 'string' },
      width: { type: 'string' },
      when: {
        type: 'string',
        multiple: true,
      },
      clear: { type: 'boolean' },
      id: { type: 'string' },
      to: { type: 'string' },
      before: { type: 'string' },
    },
    positionals: 2,
  })
  const action = positionals[0]

  if (action === 'list') {
    const state = loadHydra({ hydraId }).state

    return {
      columns: hydraConfig({
        state,
        id: hydraId,
      }).columns.map(column => ({
        ...column,
        rule: columnRule({ column }),
      })),
      revision: state.configRevision ?? 0,
    }
  }

  const m = meta({ values })

  if (action === 'rule' && !m.reason?.trim()) {
    throw new HydraError({
      message: 'column rule needs --reason <why>',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'resize') {
    const ref = required({
      value: positionals[1],
      what: 'column id',
    })
    const width = integer({
      value: values.width,
      flag: '--width',
    })

    if (width === undefined) {
      throw new HydraError({
        message: 'pass --width <pixels>',
        code: 'VALIDATION_ERROR',
      })
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state }) => {
        if (!hydraConfig({
          state,
          id: hydraId,
        }).columns.some(c => c.id === ref)) {
          throw new HydraError({
            message: `column not found: ${ref}`,
            code: 'NOT_FOUND',
          })
        }

        return decideView({
          state,
          patch: { columnWidths: { [ref]: width } },
          meta: m,
        })
      },
    })
  }

  let confirmation: { token?: string } | undefined
  const changesPlacement = action === 'delete' || action === 'reorder' || action === 'rule'

  if (m.actor !== 'web' && changesPlacement) {
    confirmation = { token: values.confirm as string | undefined }
  }

  return commit({
    hydraId,
    meta: m,
    confirmation,
    intent: {
      type: 'board.columns',
      card: '$board',
    },
    decide: ({ state }) => {
      const before = structuredClone(hydraConfig({
        state,
        id: hydraId,
      }).columns)
      let columns = structuredClone(before)
      const ref = positionals[1]
      const selected = columnByRef({
        columns,
        ref,
      })

      if (action !== 'create' && !selected) {
        throw new HydraError({
          message: `column not found: ${ref}`,
          code: 'NOT_FOUND',
        })
      }

      if (action === 'delete' && lockedColumn({
        state,
        id: selected!.id,
      })) {
        throw new HydraError({
          message: LOCKED_DELETE,
          code: 'VALIDATION_ERROR',
        })
      }

      let fallback: Column | undefined

      if (action === 'create') {
        const id = String(values.id ?? `custom:${randomUUID()}`)

        if (!/^custom:[a-z0-9-]{1,60}$/.test(id)) {
          throw new HydraError({
            message: 'new column ids use custom:<letters-digits-dashes>',
            code: 'VALIDATION_ERROR',
          })
        }

        columns.push({
          id: id as Column,
          title: required({
            value: values.title as string,
            what: '--title',
          }),
          description: String(values.description ?? ''),
          rule: [],
        })
      } else if (action === 'rule') {
        const when = values.when as string[] | undefined ?? []

        if ((!values.clear && !when.length) || (values.clear && when.length)) {
          throw new HydraError({
            message: 'pass --when <fact[,fact]> (repeat for OR), or --clear for manual placement',
            code: 'VALIDATION_ERROR',
          })
        }

        selected!.rule = parseColumnRule({ when })
      } else if (action === 'rename') {
        selected!.title = required({
          value: values.title as string,
          what: '--title',
        })
      } else if (action === 'describe') {
        if (typeof values.description !== 'string') {
          throw new HydraError({
            message: 'pass --description <text> (empty text clears it)',
            code: 'VALIDATION_ERROR',
          })
        }

        selected!.description = values.description
      } else if (action === 'delete') {
        columns = columns.filter(c => c.id !== selected!.id)
        fallback = values.to
          ? columnByRef({
            columns,
            ref: values.to as string,
          })?.id : columns[0]?.id

        if (values.to && !fallback) {
          throw new HydraError({
            message: 'fallback column not found',
            code: 'VALIDATION_ERROR',
          })
        }
      } else if (action === 'reorder') {
        columns = columns.filter(c => c.id !== selected!.id)
        const above = values.before ? columnByRef({
          columns,
          ref: values.before as string,
        }) : undefined
        const index = above ? columns.indexOf(above) : columns.length

        if (values.before && !above) {
          throw new HydraError({
            message: '--before column not found',
            code: 'VALIDATION_ERROR',
          })
        }

        columns.splice(
          index,
          0,
          selected!,
        )

        if (columns.every((
          c,
          i,
        ) => c.id === before[i]!.id)) {
          return { skipped: 'unchanged' }
        }
      } else {
        throw new HydraError({
          message: 'Use column list, create, rename, describe, rule, resize, delete or reorder',
          code: 'VALIDATION_ERROR',
        })
      }

      validateColumns({ columns })

      if (isDeepStrictEqual(
        columns,
        before,
      )) {
        return { skipped: 'unchanged' }
      }

      const gone = ({ id }: { id?: Column }) =>
        id !== undefined && !columns.some(column => column.id === id)
      const placements = Object.fromEntries(Object.values(state.cards)
        .filter(c => gone({ id: c.column }))
        .map(c => [
          c.id,
          {
            before: c.column,
            after: fallback ?? columns[0]!.id,
          },
        ]))

      if (changesPlacement) {
        const config = hydraConfig({
          state,
          id: hydraId,
        })
        const proposed = {
          ...state,
          config: {
            ...config,
            columns,
          },
        }

        for (const move of lifecycleMoves({
          before: state,
          state: proposed,
        })) {
          if (placements[move.cardId]) {
            continue
          }

          placements[move.cardId] = {
            before: state.cards[move.cardId]!.column,
            after: move.column,
          }
        }
      }

      return hydraEvent({
        state,
        meta: m,
        cardId: '$board',
        change: {
          type: 'board.columns',
          data: {
            columns,
            before,
            placements,
            ...(fallback ? { fallback } : {}),
          },
        },
      })
    },
  })
}

export const columnCommandHandler = guard({ handler: ({ args }) => columnCommand({ args }) })

export const NOTES_SHOWN = 3

export const NOTE_CUT = 280

const NOTE_SECTIONS = {
  summary: 'summary',
  decision: 'decisions',
  context: 'context',
} as const

function cardNotes({
  hydraId,
  card,
  full,
}: {
  hydraId: string
  card: Card
  full: boolean
}): {
  notes: Output
  cut: boolean
} {
  const ids = new Set((card.notes ?? []).map(n => n.id))
  // A moved task's notes stay in the logs of the Hydras it came from.
  const events = ids.size ? movedHistory({
    hydraId,
    task: card.id,
    matches: ({ event }) => event.type === 'card.noted' && ids.has(event.id),
  }).flatMap(({ event }) => (event.type === 'card.noted' ? [event] : [])) : []
  let cut = false
  const notes: Output = {}

  for (const [
    kind,
    section,
  ] of Object.entries(NOTE_SECTIONS)) {
    const all = events
      .filter(e => e.data.kind === kind)
      .map(e => ({
        at: e.data.at ?? e.at,
        source: e.data.source,
        text: e.data.text,
      }))
    all.sort((
      a,
      b,
    ) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    const shown = full ? all : all.slice(
      0,
      NOTES_SHOWN,
    ).map(n => ({
      ...n,
      text: clip({
        text: n.text,
        limit: NOTE_CUT,
      }),
    }))

    if (shown.length < all.length || shown.some((
      n,
      i,
    ) => n.text !== all[i]!.text)) {
      cut = true
    }

    notes[section] = shown.length ? shown : 'none'

    if (shown.length < all.length) {
      notes[`${section}More`] = all.length - shown.length
    }
  }

  return {
    notes,
    cut,
  }
}

export const card = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        full: { type: 'boolean' },
      },
      positionals: 1,
    })
    const { state } = loadHydra({ hydraId })
    const found = findCard({
      state,
      ref: required({
        value: positionals[0],
        what: 'card id',
      }),
    })
    const {
      notes,
      cut,
    } = cardNotes({
      hydraId,
      card: found,
      full: Boolean(values.full),
    })
    const help = [`Run \`pnyx-axi history --card ${found.id}\` for its events`]

    if (cut || (!values.full && (found.brief ?? '').length > TEXT_CUT)) {
      help.unshift(`Run \`pnyx-axi card ${found.id} --full\` for the brief and every note in full`)
    }

    // A worker may not run harvest or reply, so it is not pointed at them.
    const worker = workerIdentity()

    if (!found.notes?.length && !worker) {
      help.push(`Run \`pnyx-axi harvest --card ${found.id}\` to collect its summaries, decisions and context`)
    }

    const asking = found.attention.find(request => answerPrompt({
      card: found,
      request,
    }))

    if (asking && !worker) {
      help.unshift(`Run \`pnyx-axi reply ${found.id} --answer ${asking.key} --json <answer>\` to answer its ${asking.kind} (see \`pnyx-axi reply --help\`)`)
    }

    return {
      card: cardDetail({
        state,
        card: found,
        full: Boolean(values.full),
      }),
      notes,
      help,
    }
  },
})

export const move = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: {
        ...WRITE,
        before: { type: 'string' },
      },
      positionals: 2,
    })
    const m = meta({ values })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const target = column({
      value: required({
        value: positionals[1],
        what: 'column',
      }),
    })
    const before = values.before as string | undefined

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.moved',
        card: ref,
      },
      ...(m.actor !== 'web' ? { confirmation: { token: values.confirm as string | undefined } } : {}),
      decide: ({ state }) => decideMove({
        state,
        ref,
        column: columnByRef({
          columns: hydraConfig({ state }).columns,
          ref: target,
        })?.id ?? target,
        before,
        meta: m,
      }),
    })
  },
})
