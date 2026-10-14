// pnyx-axi board commands. Every write goes through `commit`, which holds the
// board's writer lock, ingests the hook spool, then appends at most one event.
import { DEFAULT_VIEW, viewFor } from '../core/view.ts'
import { readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { isDeepStrictEqual, parseArgs, type ParseArgsConfig } from 'node:util'
import { AxiError } from 'axi-sdk-js'
import {
  decideLink,
  decideMove,
  decideOutcome,
  decidePush,
  decideView,
  decideUndo,
  findCard,
  joinedKey,
  parseLink,
  type Decision,
  type Meta,
} from '../core/decide.ts'
import {
  BoardError,
  COLUMNS,
  EVENT_TYPES,
  OUTCOME_STATES,
  type BoardEvent,
  type BoardState,
  type Card,
  type EventType,
  type Column,
  type NotedEvent,
  type OutcomeState,
} from '../core/model.ts'
import { emptyBoard, replay } from '../core/reducer.ts'
import { terminalFacts } from '../core/route.ts'
import { readServer } from '../server/state.ts'
import { detectedHarnesses, setupHooks } from '../integrations/hooks/install.ts'
import { appendNote, harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { HARNESSES, TERMINAL_EVENTS, attend, isHookEnvelope, observe, type Harness, type HookEnvelope } from '../integrations/hooks/observe.ts'
import { pullRequestNote } from '../integrations/github/pull-request.ts'
import { loadBoard, readEvents, repairBoard, spoolFiles, withWriter, type Writer } from '../store/board-store.ts'

const DEFAULT_BOARD = 'default'
const HISTORY_LIMIT = 20
const HISTORY_MAX = 100
const HOME_LIMIT = 50

export type Output = Record<string, unknown>
export type Options = NonNullable<ParseArgsConfig['options']>

export const COMMON: Options = { board: { type: 'string' } }
const WRITE: Options = {
  ...COMMON,
  actor: { type: 'string' },
  reason: { type: 'string' },
  'event-id': { type: 'string' },
  'if-revision': { type: 'string' },
}

export function parse({ args, options, positionals }: {
  args: string[]
  options: Options
  positionals: number
}) {
  let parsed

  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true })
  } catch (error) {
    throw new AxiError((error as Error).message, 'VALIDATION_ERROR', ['Run the command with --help'])
  }

  if (parsed.positionals.length > positionals) {
    throw new AxiError(`unexpected argument: ${parsed.positionals[positionals]}`, 'VALIDATION_ERROR', [
      'Run the command with --help',
    ])
  }

  const values = parsed.values as Record<string, string | boolean | undefined>

  return {
    values,
    positionals: parsed.positionals,
    board: (values.board as string | undefined) ?? DEFAULT_BOARD,
  }
}

export function required({ value, what }: { value: string | undefined; what: string }): string {
  if (!value) {
    throw new AxiError(`missing ${what}`, 'VALIDATION_ERROR', ['Run the command with --help'])
  }

  return value
}

function integer({ value, flag }: {
  value: string | boolean | undefined
  flag: string
}): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AxiError(`${flag} must be a non-negative integer`, 'VALIDATION_ERROR')
  }

  return Number(value)
}

export function meta({ values }: { values: Record<string, string | boolean | undefined> }): Meta {
  const m: Meta = { at: new Date().toISOString(), actor: (values.actor as string | undefined) ?? 'cli' }

  if (typeof values.reason === 'string') {
    m.reason = values.reason
  }

  if (typeof values['event-id'] === 'string') {
    m.id = values['event-id']
  }

  const ifRevision = integer({ value: values['if-revision'], flag: '--if-revision' })

  if (ifRevision !== undefined) {
    m.ifRevision = ifRevision
  }

  return m
}

// The folder's canonical path, or the path as given when it cannot be resolved.
export function canonical({ path }: { path: unknown }): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return undefined
  }

  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// Hook events after which a session's transcript has turns worth harvesting.
const HARVEST_AFTER = ['Stop', 'SubagentStop', 'PostCompact', 'SessionEnd']
// The source of the "ended" outcome a hook records.
const HOOKS = 'hooks'

// Appends what one spool entry reports: a raw harness hook payload becomes card
// observations, anything else is a push with an explicit key. Returns the cards
// whose transcripts to harvest.
function ingest({ writer, entry }: { writer: Writer; entry: Record<string, unknown> }): string[] {
  if (typeof entry?.id !== 'string' || typeof entry.at !== 'string') {
    throw new BoardError({ message: 'spool entry needs id and at', code: 'VALIDATION_ERROR' })
  }

  const apply = ({ decision }: { decision: Decision }) => {
    if ('event' in decision) {
      writer.append({ event: decision.event })
    }
  }

  if (!isHookEnvelope({ value: entry })) {
    if (typeof entry.key !== 'string') {
      throw new BoardError({ message: 'spool entry needs id, key and at', code: 'VALIDATION_ERROR' })
    }

    const actor = typeof entry.actor === 'string' ? entry.actor : 'hook'
    const card = (entry.card ?? {}) as Record<string, unknown>
    const source = card.source ?? { adapter: actor, objectId: entry.key, observedAt: entry.at }
    apply({
      decision: decidePush(
        {
          state: writer.state,
          key: entry.key,
          input: {
            ...card,
            source,
          },
          meta: {
            id: entry.id,
            at: entry.at,
            actor,
          },
        },
      ),
    })

    return []
  }

  if (!(HARNESSES as readonly string[]).includes(entry.harness as string) || typeof entry.event !== 'string') {
    throw new BoardError({ message: 'hook entry needs a known harness and an event', code: 'VALIDATION_ERROR' })
  }

  const harvest: string[] = []
  const folder = canonical({ path: (entry.payload as { cwd?: unknown } | null)?.cwd })
  const terminal = terminalFacts({ value: entry.terminal })
  const probed = TERMINAL_EVENTS.includes(entry.event)
  // A session (never a subagent, whose key has a /) started in a folder a source
  // assigned, such as a Firstmate task's worktree, reports to that card.
  const resolve = ({ key }: { key: string }) => (key.includes('/') ? key : joinedKey({ state: writer.state, key, folder, terminal, probed }))

  for (const o of observe({ envelope: entry as unknown as HookEnvelope })) {
    const key = resolve({ key: o.key })

    if (o.ifMissing && key in writer.state.keys) {
      continue
    }

    const card = typeof o.card.parent === 'string' ? { ...o.card, parent: resolve({ key: o.card.parent }) } : o.card
    const m: Meta = { id: o.id ? `${entry.id}:${o.id}` : entry.id, at: entry.at, actor: `hook:${entry.harness}` }
    const current = writer.state.cards[writer.state.keys[key] ?? '']?.attention ?? []
    const attention = o.attend && attend({ current, change: o.attend })

    if (o.ifChanged && key in writer.state.keys && isDeepStrictEqual(attention, current)) {
      continue
    }

    const pushed = decidePush({
      state: writer.state,
      key,
      input: attention ? {
        ...card,
        attention,
      } : card,
      meta: m,
    })
    apply({ decision: pushed })
    // Hooks own only the outcome they recorded on the session's own card: a joined
    // Firstmate task, or a Firstmate or manual outcome, keeps its own rule.
    const target = writer.state.cards[writer.state.keys[key] ?? '']
    const stale = 'skipped' in pushed && pushed.skipped === 'stale'
    const owned = key === o.key && (!target?.outcome || target.outcome.source === HOOKS)

    if (o.outcome !== undefined && target && !stale && owned) {
      const outcome = o.outcome && { state: o.outcome }
      apply({ decision: decideOutcome({ state: writer.state, ref: key, outcome, meta: { ...m, id: `${m.id}:outcome` }, source: HOOKS }) })
    }

    if (o.link) {
      apply({ decision: decideLink({ state: writer.state, ref: key, url: o.link, link: parseLink({ input: { url: o.link } }), meta: { ...m, id: `${m.id}:link` } }) })
    }

    if (!o.ifMissing && !o.ifChanged && HARVEST_AFTER.includes(entry.event)
      && key in writer.state.keys) {
      harvest.push(writer.state.keys[key]!)
    }
  }

  return harvest
}

// Folds spooled hook events into the log, oldest first. Each push is recorded as a
// source observation, so it can never be undone. A file that cannot be read is
// renamed to *.rejected so it is not retried forever. Then harvests the notes in
// the transcripts of sessions that finished a turn.
export function drainSpool({ writer }: {
  writer: Writer
}): {
  ingested: number
  rejected: number
  notes?: number
} {
  let ingested = 0
  let rejected = 0
  const harvest = new Set<string>()

  for (const file of spoolFiles({ dir: writer.dir })) {
    try {
      for (const id of ingest({ writer, entry: JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> })) {
        harvest.add(id)
      }
    } catch (error) {
      if (!(error instanceof BoardError || error instanceof SyntaxError)) {
        throw error
      }

      renameSync(file, `${file}.rejected`)
      rejected += 1
      continue
    }

    rmSync(file)
    ingested += 1
  }

  const notes = harvest.size ? harvestTranscripts({
    writer,
    cardIds: harvest,
    at: new Date().toISOString(),
  }) : 0

  return { ingested, rejected, ...(notes ? { notes } : {}) }
}

// The server's way into the same writer: drain the spool under the writer lock.
export function ingestSpool({ board }: {
  board: string
}): {
  ingested: number
  rejected: number
  notes?: number
} {
  return withWriter({ board, fn: ({ writer }) => drainSpool({ writer }) })
}

function receipt({ state, event }: { state: BoardState; event: BoardEvent }): Output {
  if (event.type === 'board.view') {
    return {
      event: { seq: event.seq, id: event.id, type: event.type },
      viewRevision: state.viewRevision,
    }
  }

  const card = state.cards[event.cardId]!

  return {
    event: { seq: event.seq, id: event.id, type: event.type },
    card: { id: card.id, column: card.column, revision: card.revision },
  }
}

// What a write is about: its event type and the card's id or key.
interface Intent {
  type: EventType
  card: string
}

// The receipt the event with this id got when it was appended. An id already used
// for another card or event type is a conflict, not a retry.
function originalReceipt(
  { board, state, id, seq, intent }: {
    board: string
    state: BoardState
    id: string
    seq: number
    intent: Intent
  },
): Output {
  const events = readEvents({ board })
  const index = events.findIndex(e => e.id === id && e.seq === seq)
  const original = events[index]!

  if (
    original.type !== intent.type
    || (original.cardId !== intent.card && state.keys[intent.card] !== original.cardId)
  ) {
    throw new AxiError(`event id ${id} was already used by ${original.type} on card ${original.cardId}`, 'IDEMPOTENCY_CONFLICT', [
      'Retry with a new --event-id',
    ])
  }

  return {
    ...receipt({
      state: replay({
        state: emptyBoard(),
        events: events.slice(0, index + 1),
      }),
      event: original,
    }),
    duplicate: 'event id already applied; nothing appended',
  }
}

// A repeated --event-id answers with the original receipt before any other check,
// so a retry of a write that already landed never reports a conflict.
function commit(
  { board, meta, intent, decide }: {
    board: string
    meta: Meta
    intent: Intent
    decide: (
      { state }: {
        state: BoardState
      },
    ) => Decision
  },
): Output {
  return withWriter({
    board,
    fn: ({ writer }) => {
      const spool = drainSpool({ writer })
      const seq = meta.id === undefined ? undefined : writer.state.eventIds[meta.id]
      let out: Output

      if (seq !== undefined) {
        out = originalReceipt({ board, state: writer.state, id: meta.id!, seq, intent })
      } else {
        const decision = decide({ state: writer.state })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }

        out = 'event' in decision ? receipt({ state: writer.state, event: decision.event }) : { event: `none: ${decision.skipped}` }
      }

      if (spool.ingested || spool.rejected) {
        out.spool = spool
      }

      return out
    },
  })
}

// Maps core and store errors onto AXI's structured errors.
export function guard<T = Output>({ handler }: { handler: ({ args }: { args: string[] }) => T }) {
  return (args: string[]): T => {
    try {
      return handler({ args })
    } catch (error) {
      if (error instanceof BoardError) {
        throw new AxiError(error.message, error.code, error.help)
      }

      throw error
    }
  }
}

function column({ value }: { value: string }): Column {
  const c = value.startsWith('custom:') ? value : value.replace(/-/g, '_')

  if (!(COLUMNS as readonly string[]).includes(c) && !/^custom:[a-z0-9-]{1,60}$/.test(c)) {
    throw new AxiError(`unknown column: ${value}`, 'VALIDATION_ERROR', [`Use one of ${COLUMNS.join(', ')}`])
  }

  return c as Column
}

function cardRow({ card }: { card: Card }) {
  return {
    id: card.id,
    title: card.title,
    column: card.column,
    attention: card.attention.map(a => a.kind).join(' ') || 'none',
  }
}

function cardDetail({ card }: { card: Card }): Output {
  const detail: Output = {
    id: card.id,
    key: card.key,
    title: card.title,
    workspace: card.workspace,
    column: card.column,
    placement: card.manualColumn ? 'manual' : 'auto',
    tags: card.tags.length ? card.tags : 'none',
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

  if (card.settings) {
    detail.settings = card.settings
  }

  detail.attention = card.attention.length ? card.attention : 'none'
  detail.links = card.links.length
    ? card.links.map(l => ({ kind: l.kind, number: l.number ?? '', title: l.title ?? '', state: l.state ?? 'unknown', url: l.url }))
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

export async function home(): Promise<Output> {
  const { dir, state, tornBytes } = loadBoard({ board: DEFAULT_BOARD })
  const cards = Object.values(state.cards)
  const columns = Object.fromEntries(
    COLUMNS.map(c => [c, cards.filter(card => card.column === c).length]),
  )
  // Reports the server; never starts it.
  const server = await readServer({ board: DEFAULT_BOARD })
  const out: Output = { board: DEFAULT_BOARD, server: server ? `running at ${server.url}` : 'not running', columns }

  if (tornBytes > 0) {
    out.warning = 'events.jsonl has a torn tail; run `pnyx-axi repair`'
  }

  const serveHint = server ? [] : ['Run `pnyx-axi serve` to start the board server']
  const spooled = spoolFiles({ dir }).length

  if (spooled > 0) {
    out.spool = `${spooled} hook events waiting; the next write ingests them`
  }

  if (cards.length === 0) {
    out.cards = 'none: no cards yet'
    out.help = ['Run `pnyx-axi push --key <key> --file card.json` to add a card', ...serveHint]

    return out
  }

  const order = ({ card: c }: { card: Card }) => (COLUMNS as readonly string[]).indexOf(c.column)
  const sorted = cards.sort((a, b) =>
    order({
      card: a,
    }) - order({
      card: b,
    }) || b.updatedSeq - a.updatedSeq)
  out.cards = sorted.slice(0, HOME_LIMIT).map(card => cardRow({ card }))
  out.help = ['Run `pnyx-axi card <id>` for details', 'Run `pnyx-axi history` for recent events', ...serveHint]

  if (sorted.length > HOME_LIMIT) {
    out.more = `${sorted.length - HOME_LIMIT} more cards not shown`
  }

  return out
}

const push = guard({
  handler: ({ args }) => {
    const { values, board } = parse({ args, options: { ...WRITE, key: { type: 'string' }, file: { type: 'string' } }, positionals: 0 })
    const m = meta({ values })
    const key = required({ value: values.key as string | undefined, what: '--key' })
    const file = required({ value: values.file as string | undefined, what: '--file' })
    let input: unknown

    try {
      input = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8'))
    } catch (error) {
      throw new AxiError(`cannot read card JSON from ${file}: ${(error as Error).message}`, 'VALIDATION_ERROR')
    }

    return commit({ board, meta: m, intent: { type: 'card.pushed', card: key }, decide: ({ state }) => decidePush({ state, key, input, meta: m }) })
  },
})

// Notes shown per section by default, and the text length each is cut to.
const NOTES_SHOWN = 3
const NOTE_CUT = 280
const NOTE_SECTIONS = { summary: 'summary', decision: 'decisions', context: 'context' } as const

// The card's Summary, Decisions and Context notes, newest first. The text comes
// from the log, where each noted event keeps it.
function cardNotes({ board, card, full }: {
  board: string
  card: Card
  full: boolean
}): {
  notes: Output
  cut: boolean
} {
  const ids = new Set((card.notes ?? []).map(n => n.id))
  const events = ids.size ? readEvents({ board }).filter((e): e is NotedEvent => e.type === 'card.noted' && ids.has(e.id)) : []
  let cut = false
  const notes: Output = {}

  for (const [kind, section] of Object.entries(NOTE_SECTIONS)) {
    const all = events
      .filter(e => e.data.kind === kind)
      .map(e => ({ at: e.data.at ?? e.at, source: e.data.source, text: e.data.text }))
    all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    const shown = full ? all : all.slice(0, NOTES_SHOWN).map(n => (n.text.length > NOTE_CUT ? { ...n, text: `${n.text.slice(0, NOTE_CUT)}…` } : n))

    if (shown.length < all.length || shown.some((n, i) => n.text !== all[i]!.text)) {
      cut = true
    }

    notes[section] = shown.length ? shown : 'none'

    if (shown.length < all.length) {
      notes[`${section}More`] = all.length - shown.length
    }
  }

  return { notes, cut }
}

const card = guard({
  handler: ({ args }) => {
    const { values, positionals, board } = parse({ args, options: { ...COMMON, full: { type: 'boolean' } }, positionals: 1 })
    const found = findCard({ state: loadBoard({ board }).state, ref: required({ value: positionals[0], what: 'card id' }) })
    const { notes, cut } = cardNotes({ board, card: found, full: Boolean(values.full) })
    const help = [`Run \`pnyx-axi history --card ${found.id}\` for its events`]

    if (cut) {
      help.unshift(`Run \`pnyx-axi card ${found.id} --full\` for every note in full`)
    }

    if (!found.notes?.length) {
      help.push(`Run \`pnyx-axi harvest --card ${found.id}\` to collect its summaries, decisions and context`)
    }

    return { card: cardDetail({ card: found }), notes, help }
  },
})

// Collects the notes sources already recorded: the cards' transcripts from where
// the last read stopped, and each linked pull request's title and description.
// ponytail: reads every linked pull request on each run; skip merged ones already noted if boards grow.
const harvest = guard({
  handler: ({ args }) => {
    const { values, board } = parse({ args, options: { ...COMMON, card: { type: 'string' } }, positionals: 0 })
    const { state } = loadBoard({ board })
    const cards = values.card ? [findCard({
      state,
      ref: values.card as string,
    })] : Object.values(state.cards)
    // Read before taking the writer lock: gh-axi can be slow and must not block other writers.
    const prs = cards.flatMap(c => c.links.filter(l => l.kind === 'github_pr').map(l => ({ card: c.id, url: l.url, note: pullRequestNote({ url: l.url }) })))

    return withWriter({
      board,
      fn: ({ writer }) => {
        const spool = drainSpool({ writer })
        const at = new Date().toISOString()
        let notes = harvestTranscripts({ writer, cardIds: cards.map(c => c.id), at })

        for (const pr of prs) {
          if (pr.note) {
            notes += appendNote({ writer, cardId: pr.card, note: pr.note, at })
          }
        }

        const unread = prs.filter(pr => !pr.note).map(pr => pr.url)
        const out: Output = { harvested: { cards: cards.length, notes: notes ? `${notes} new` : 'none: nothing new', pullRequests: prs.length - unread.length } }

        if (unread.length) {
          out.unread = unread
        }

        if (spool.ingested || spool.rejected) {
          out.spool = spool
        }

        out.help = [
          ...(unread.length ? ['gh-axi could not read those pull requests; check `gh-axi pr view <number> --repo <owner/repo>`'] : []),
          values.card ? `Run \`pnyx-axi card ${cards[0]!.id}\` to see its notes` : "Run `pnyx-axi card <id>` to see a card's notes",
        ]

        return out
      },
    })
  },
})

const move = guard({
  handler: ({ args }) => {
    const { values, positionals, board } = parse({ args, options: { ...WRITE, auto: { type: 'boolean' } }, positionals: 2 })
    const m = meta({ values })
    const ref = required({ value: positionals[0], what: 'card id' })

    if (Boolean(values.auto) === (positionals[1] !== undefined)) {
      throw new AxiError('give either a column or --auto', 'VALIDATION_ERROR', [`Columns: ${COLUMNS.join(', ')}`])
    }

    const target = values.auto ? null : column({ value: positionals[1]! })

    return commit({ board, meta: m, intent: { type: 'card.moved', card: ref }, decide: ({ state }) => decideMove({ state, ref, column: target, meta: m }) })
  },
})

const link = guard({
  handler: ({ args }) => {
    const options: Options = {
      ...WRITE,
      url: { type: 'string' },
      kind: { type: 'string' },
      number: { type: 'string' },
      title: { type: 'string' },
      state: { type: 'string' },
      remove: { type: 'boolean' },
    }
    const { values, positionals, board } = parse({ args, options, positionals: 1 })
    const m = meta({ values })
    const ref = required({ value: positionals[0], what: 'card id' })
    const url = required({ value: values.url as string | undefined, what: '--url' })
    const s = ({ name }: { name: string }) => values[name] as string | undefined
    const parsed = values.remove
      ? null
      : parseLink({ input: { url, kind: s({ name: 'kind' }), number: s({ name: 'number' }), title: s({ name: 'title' }), state: s({ name: 'state' }), checkedAt: s({ name: 'state' }) && new Date().toISOString() } })

    return commit({ board, meta: m, intent: { type: 'card.linked', card: ref }, decide: ({ state }) => decideLink({ state, ref, url, link: parsed, meta: m }) })
  },
})

const outcome = guard({
  handler: ({ args }) => {
    const { values, positionals, board } = parse({ args, options: { ...WRITE, note: { type: 'string' }, clear: { type: 'boolean' } }, positionals: 2 })
    const m = meta({ values })
    const ref = required({ value: positionals[0], what: 'card id' })
    const state = positionals[1]

    if (Boolean(values.clear) === (state !== undefined)) {
      throw new AxiError('give either an outcome or --clear', 'VALIDATION_ERROR', [`Outcomes: ${OUTCOME_STATES.join(', ')}`])
    }

    if (state !== undefined && !(OUTCOME_STATES as readonly string[]).includes(state)) {
      throw new AxiError(`unknown outcome: ${state}`, 'VALIDATION_ERROR', [`Use one of ${OUTCOME_STATES.join(', ')}`])
    }

    const note = values.note as string | undefined
    const result = state === undefined
      ? null
      : { state: state as OutcomeState, ...(note ? { note } : {}) }

    return commit({ board, meta: m, intent: { type: 'card.outcome', card: ref }, decide: ({ state: s }) => decideOutcome({ state: s, ref, outcome: result, meta: m }) })
  },
})

function summarize({ event }: { event: BoardEvent }): string {
  const undo = event.undoes ? `undo ${event.undoes}: ` : ''

  switch (event.type) {
    case 'board.view': return 'View preferences changed'
    case 'card.pushed':
      return `${undo}${Object.keys(event.data).filter(k => k !== 'key' && k !== 'before')
        .join(' ') || 'no fields'}`
    case 'card.moved':
      return `${undo}${event.data.before ?? 'auto'} -> ${event.data.after ?? 'auto'}`
    case 'card.linked': {
      const l = event.data.after ?? event.data.before
      const label = l ? `${l.kind}${l.number ? ` #${l.number}` : ''}` : event.data.url

      return `${undo}${event.data.after ? `${label} ${event.data.after.state ?? 'unknown'}` : `removed ${label}`}`
    }
    case 'card.outcome':
      return `${undo}${event.data.after ? `${event.data.after.state}${event.data.after.note ? `: ${event.data.after.note}` : ''}` : 'cleared'}`
    case 'card.replied':
      return `reply ${event.data.reply} ${event.data.state}${event.data.detail ? `: ${event.data.detail}` : ''}`
    case 'card.noted':
      return `${event.data.kind} from ${event.data.source}`
  }
}

const history = guard({
  handler: ({ args }) => {
    const options: Options = {
      ...COMMON,
      card: { type: 'string' },
      kind: { type: 'string' },
      workspace: { type: 'string' },
      before: { type: 'string' },
      limit: { type: 'string' },
    }
    const { values, board } = parse({ args, options, positionals: 0 })
    const limit = Math.min(integer({ value: values.limit, flag: '--limit' }) ?? HISTORY_LIMIT, HISTORY_MAX)
    const before = integer({ value: values.before, flag: '--before' })
    const kind = values.kind as string | undefined
    const type = kind && (kind.startsWith('card.') ? kind : `card.${kind}`)

    if (type && !(EVENT_TYPES as readonly string[]).includes(type)) {
      throw new AxiError(`unknown kind: ${kind}`, 'VALIDATION_ERROR', ['Use one of pushed, moved, linked, outcome, replied, noted'])
    }

    const { state } = loadBoard({ board })
    const cardId = values.card ? findCard({ state, ref: values.card as string }).id : undefined
    const workspace = values.workspace as string | undefined
    // An outcome keeps the workspace it was recorded under; other events use the card's current one.
    const inWorkspace = ({ e }: { e: BoardEvent }) =>
      (e.type === 'card.outcome' ? e.data.card.workspace : state.cards[e.cardId]?.workspace) === workspace

    const matches = readEvents({ board })
      .filter(e => (before === undefined || e.seq < before) && (!cardId || e.cardId === cardId))
      .filter(e => (!type || e.type === type) && (!workspace || inWorkspace({ e })))
      .reverse()
    const page = matches.slice(0, limit)

    if (page.length === 0) {
      return { events: 'none: no matching events' }
    }

    const out: Output = {
      events: page.map(e => ({
        seq: e.seq,
        id: e.id,
        at: e.at,
        type: e.type,
        card: e.cardId,
        actor: e.actor,
        summary: summarize({ event: e }),
      })),
    }

    if (matches.length > limit) {
      const flags = ['card', 'kind', 'workspace', 'limit', 'board'].flatMap(f => (values[f] ? [`--${f}`, String(values[f])] : []))
      out.help = [`Run \`pnyx-axi history ${[...flags, '--before', String(page.at(-1)!.seq)].join(' ')}\` for older events`]
    }

    return out
  },
})

const undo = guard({
  handler: ({ args }) => {
    const { values, positionals, board } = parse({ args, options: WRITE, positionals: 1 })
    const m = meta({ values })
    const id = required({ value: positionals[0], what: 'event id' })
    const target = readEvents({ board }).find(e => e.id === id)

    if (!target) {
      throw new AxiError(`event not found: ${id}`, 'NOT_FOUND', ['Run `pnyx-axi history` to find event ids'])
    }

    return commit(
      {
        board,
        meta: m,
        intent: {
          type: target.type,
          card: target.cardId,
        },
        decide: ({ state }) =>
          decideUndo({
            state,
            target,
            meta: m,
          }),
      },
    )
  },
})

const repair = guard({
  handler: ({ args }) => {
    const { board } = parse({ args, options: COMMON, positionals: 0 })
    const result = repairBoard({ board })

    return {
      repair: result.tornBytes > 0 ? `set aside ${result.tornBytes} torn bytes` : 'none: log ends cleanly',
      ...(result.preserved ? { preserved: result.preserved } : {}),
      snapshot: `rebuilt through seq ${result.seq}`,
    }
  },
})

const setup = guard({
  handler: ({ args }) => {
    const options: Options = { harness: { type: 'string' }, remove: { type: 'boolean' }, preview: { type: 'boolean' } }
    const { values, positionals } = parse({ args, options, positionals: 1 })

    if (positionals[0] !== 'hooks') {
      throw new AxiError(`unknown setup target: ${positionals[0] ?? '(none)'}`, 'VALIDATION_ERROR', ['Run `pnyx-axi setup hooks`'])
    }

    const harness = values.harness as string | undefined

    if (harness !== undefined && !(HARNESSES as readonly string[]).includes(harness)) {
      throw new AxiError(`unknown harness: ${harness}`, 'VALIDATION_ERROR', [`Use one of ${HARNESSES.join(', ')}`])
    }

    const targets = harness ? [harness as Harness] : detectedHarnesses()

    if (targets.length === 0) {
      throw new AxiError('no Claude Code or Codex config folder found', 'NOT_FOUND', ['Run `pnyx-axi setup hooks --harness claude|codex`'])
    }

    const remove = Boolean(values.remove)
    const preview = Boolean(values.preview)
    const hooks = targets.map(h => setupHooks({ harness: h, opts: { remove, preview } }))
    const out: Output = { hooks }

    if (preview) {
      out.preview = 'nothing written; rerun without --preview to apply'
    }

    const help: string[] = []

    if (!remove && !preview && targets.includes('codex')) {
      help.push('Codex asks you to review and trust new hooks: run `/hooks` in Codex')
    }

    help.push(remove ? 'Run `pnyx-axi setup hooks` to install them again' : 'New sessions appear on the board; run `pnyx-axi` to see it')
    out.help = help

    return out
  },
})

const view = guard({
  handler: ({ args }) => {
    const [sub, ...rest] = args
    const { values, board } = parse({ args: rest, options: { ...WRITE, json: { type: 'string' } }, positionals: 0 })

    if (sub === 'show') {
      const { state } = loadBoard({ board })

      return { view: viewFor({ state }), revision: state.viewRevision ?? 0 }
    }

    if (sub === 'schema') {
      return { defaults: DEFAULT_VIEW, help: ['view set --json <patch> --if-revision <revision>'] }
    }

    if (sub !== 'set') {
      throw new AxiError('use view show, schema or set', 'VALIDATION_ERROR')
    }

    let patch: unknown

    try {
      patch = JSON.parse(required({ value: values.json as string, what: '--json' }))
    } catch {
      throw new AxiError('--json must contain a preference object', 'VALIDATION_ERROR')
    }

    const m = meta({ values })

    return commit({ board, meta: m, intent: { type: 'board.view', card: '$board' }, decide: ({ state: s }) => decideView({ state: s, patch, meta: m }) })
  },
})

export const commands = {
  view,
  push,
  card,
  harvest,
  move,
  link,
  outcome,
  history,
  undo,
  repair,
  setup,
}

export const TOP_LEVEL_HELP = `usage: pnyx-axi [command] [args] [flags]
description: Deterministic board of every agent and its work
commands:
  pnyx-axi                                   Show the board summary
  push --key <key> --file <card.json|->      Create or update the card with this key
  card <id|key> [--full]                     Show one card with its summary, decisions and context
  harvest [--card <id>]                      Collect summaries and decisions sources already recorded
  move <id> <column> | --auto                Pin a card to a column, or return it to automatic placement
  link <id> --url <url> [--state open]       Add, update or --remove a link
  outcome <id> done|failed|cancelled         Record the task outcome (--note, --clear)
  history [--card <id>] [--before <seq>]     Page through past events, newest first
  search "<words>" | status | rebuild        Full-text search over titles, links, events and transcripts
  settings [set <key> <value>]               Search settings: semantic search, reranker and model
  undo <event-id>                            Append the reverse of a manual edit, move, link or outcome
  view show|schema|set                        Inspect or save board view preferences
  repair                                     Set aside a torn log tail and rebuild the snapshot
  serve [--port <n>] [--home <path>]         Run the board server until stopped; --home also watches Firstmate
  stop                                       Stop the board's running server
  setup hooks [--harness claude|codex]       Install the silent reporting hooks (--remove, --preview)
  reply <id> --text <text> [--home <path>]   Send a reply through the card's Firstmate home or its session's terminal
  agent <id> [<setting> <value>]             List or change a session's model, effort, mode or fast mode from its card
  firstmate sync|watch --home <path>         Fold a Firstmate home's tasks into the board, once or on every change
flags:
  --board <name>     Board to use (default: default)
  --event-id <id>    On writes: idempotency key; a repeat returns the original receipt
  --if-revision <n>  On writes: expected card revision (0 for a new card)
  --help | --version Show command help or the installed version
`

const COMMAND_HELP: Record<string, string> = {
  push: `usage: pnyx-axi push --key <key> --file <card.json|-> [--event-id <id>] [--if-revision <n>] [--actor <who>] [--reason <text>]
Creates or updates the card with this key. Repeating the same push, or the same --event-id, appends nothing.
card.json fields (all optional): title, autoTitle {from: session|prompt|agent|folder, text} (used only while no title is set), workspace, tags[], parent (card id or key, null to clear), activity,
  agent {provider, sessionId, agentId, agentType, cwd, transcriptPath}, attention[] {kind, key, blocking, text},
  settings {<name>: <value>, or null to remove it} merged into the card's settings, such as model, effort, mode, fast,
  terminal {tty, pid, program, tmux, tmuxPane, paseoTerminal, paseoHome, herdrSession, herdrPane},
  folder (absolute path, null to clear; a hook session started there reports to this card),
  source {adapter, objectId, instanceId, generation, cursor, observedAt}
An observation older than the card's latest one from the same source is ignored.
`,
  card: `usage: pnyx-axi card <id|key> [--full] [--board <name>]
Shows the card and its notes in three sections, summary, decisions and context, newest first:
${NOTES_SHOWN} per section with text cut at ${NOTE_CUT} characters, or every note in full with --full.
`,
  harvest: `usage: pnyx-axi harvest [--card <id>] [--board <name>]
Collects notes that sources already recorded, with no model and nothing asked of agents: Claude Code
compaction summaries, session titles and AskUserQuestion answers, Codex compaction summaries, and each
linked pull request's title and description through gh-axi. Sessions are also harvested whenever a
turn ends; Firstmate decisions, reports and Captain's intent arrive through \`firstmate sync\`.
Sources are only read. Each note is kept once, so running it again appends only what is new.
`,
  move: `usage: pnyx-axi move <id> <needs_you|workers_on_it|review|done> | --auto [--event-id <id>] [--if-revision <n>] [--reason <text>]
A manual move pins the card until \`move <id> --auto\`. Attention on a pinned card stays visible.
`,
  link: `usage: pnyx-axi link <id> --url <url> [--kind github_pr|linear|url] [--number <n>] [--title <text>] [--state open|merged|closed] [--remove] [--event-id <id>] [--if-revision <n>]
GitHub pull request URLs get kind and number filled in. An open pull request puts the card in review;
all linked pull requests merged puts it in done.
`,
  outcome: `usage: pnyx-axi outcome <id> done|failed|cancelled [--note <text>] | --clear [--event-id <id>] [--if-revision <n>]
`,
  history: `usage: pnyx-axi history [--card <id>] [--kind pushed|moved|linked|outcome|replied|noted] [--workspace <name>] [--before <seq>] [--limit <n>]
Newest first, ${HISTORY_LIMIT} per page (max ${HISTORY_MAX}).
`,
  undo: `usage: pnyx-axi undo <event-id> [--event-id <id>] [--if-revision <n>]
Appends an event that reverses a manual push edit, move, link or outcome. Refused when the card changed since.
Source observations, card creation and merges cannot be undone.
`,
  setup: `usage: pnyx-axi setup hooks [--harness claude|codex] [--remove] [--preview]
Adds Pnyx's reporting hook to the user-level Claude Code settings.json or Codex hooks.json, keeping
every other hook. Without --harness it sets up each harness whose config folder exists. Rerunning
changes nothing; --remove takes out only Pnyx's entries. The hooks print nothing and always exit 0,
so they never add to the agent's context: no session-start board summary is installed.
Hook events go to the default board.
`,
  repair: `usage: pnyx-axi repair [--board <name>]
A crash mid-append can leave a torn last line; writes refuse until it is repaired.
Repair copies the torn bytes to a side file and appends a marker so readers skip them; the log is never cut.
`,
  serve: `usage: pnyx-axi serve [--port <n>] [--board <name>] [--home <Firstmate path>]...
Serves the board on 127.0.0.1 port 4747 (--port overrides it; 0 picks a random one) until SIGINT, SIGTERM or \`pnyx-axi stop\`.
Each --home is a Firstmate home: replies to its cards go through it, and its tasks are folded into the board
as \`pnyx-axi firstmate watch\` would, so no second process is needed.
Hook events arrive on the board's server.sock or through its spool. Browsers get one WebSocket at /ws:
a snapshot on connect, then events by sequence; /ws?after=<seq> resumes, a gap gets a fresh snapshot.
The handshake needs ?token=<token>: the board page served here carries it, local programs read $PNYX_HOME/token.
Commands go over the same socket: {"type":"command","id":"<id>","name":"move|link|outcome|undo","args":[...]}
gets {"type":"receipt","id":"<id>",...} or {"type":"error","id":"<id>",...}. They always write this board;
--board is refused and the actor defaults to web. GET /health answers {"board","pid"}.
`,
  stop: `usage: pnyx-axi stop [--board <name>]
`,
}

export function commandHelp({ command }: { command: string }): string | undefined {
  if (command === 'view') {
    return 'usage: pnyx-axi view show|schema|set [--json <patch>] [--if-revision <n>] [--event-id <id>] [--board <name>]'
  }

  return COMMAND_HELP[command]
}
