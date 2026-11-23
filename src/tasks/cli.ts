import { readInput } from '#app/request-context.ts'
import type { HydraState, HydraEvent } from '#app/model.ts'
import { projectsFor } from '#projects/read.ts'
import { MAX_BRIEF_LENGTH, type Card } from './model.ts'
import { clip, guard, parse, COMMON, WRITE, meta, required, commit, HISTORY_MAX, summarize, TEXT_CUT, type Output } from '#app/cli-support.ts'
import { loadHydra } from '#app/store.ts'
import { decidePush } from './push.ts'
import { HydraError } from '#store/errors.ts'
import { findCard } from './push-rules.ts'
import { taskSessions } from '#workers/session-history.ts'
import { tagsTask } from './updates.ts'
import { movedHistory, type HistoryEntry } from './move-history.ts'

const INTENT_LIMIT = 4000

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
    tags: card.tags.length ? card.tags : 'none',
  }

  if (card.notices?.length) {
    detail.notices = card.notices
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

export const push = guard({
  handler: async ({ args }) => {
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
      throw new HydraError({
        message: `cannot read card JSON from ${file}: ${(error as Error).message}`,
        code: 'VALIDATION_ERROR',
      })
    }

    return await commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.edited',
        accepts: ['session.observed'],
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

const TASK_FIELDS = [
  'attention',
  'parent',
  'status',
  'worker',
  'hold',
  'queue',
] as const

export type TaskField = (typeof TASK_FIELDS)[number]

export function taskFields({ value }: { value?: string }): TaskField[] {
  const fields = (value ?? '').split(',').map(field => field.trim())
    .filter(Boolean)
  const unknown = fields.filter(field => !TASK_FIELDS.includes(field as TaskField))

  if (unknown.length) {
    throw new HydraError({
      message: `unknown field: ${unknown.join(', ')}`,
      code: 'VALIDATION_ERROR',
      help: [`Use --fields with any of ${TASK_FIELDS.join(', ')}`],
    })
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
  const out: Output = {
    hydraId,
    task: task.id,
    sessions: sessions.size ? [...sessions].map(id => ({
      session: id,
      transcript: state.sessions?.[id]?.agent.transcriptPath ?? 'unavailable',
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

const NOTES_SHOWN = 3

const NOTE_CUT = 280

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
    const help = [`Read tasks/${found.id}/task.log for its events`]

    if (cut || (!values.full && (found.brief ?? '').length > TEXT_CUT)) {
      help.unshift(`Read tasks/${found.id}/task.log in Hydra ${hydraId} for the full brief and notes. For a moved task, follow its move records to earlier Hydra task logs for older notes`)
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
