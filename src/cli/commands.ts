import { DEFAULT_VIEW, viewFor } from '../core/view.ts'
import { randomUUID } from 'node:crypto'
import { cardSessionId, findSession, interactive, liveTask, rankOf, selfSession, sessionId } from '../core/tasks.ts'
import { paseoStatus } from '../integrations/paseo/launch.ts'
import { setupHydra, startHydra, startTask } from './start.ts'
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { boardConfig, declareTask, hydraEvent, HYDRA_CARD, validateColumns } from '../core/hydra.ts'
import type { BoardConfig, HydraIdentity } from '../core/model.ts'
import { readThread } from '../thread/read.ts'
import { isDeepStrictEqual, parseArgs, type ParseArgsConfig } from 'node:util'
import { AxiError } from 'axi-sdk-js'
import {
  decideLink,
  decideMove,
  decideOutcome,
  decidePush,
  decideView,
  decideUndo,
  decideSession,
  findCard,
  joinedKey,
  parseLink,
  type Decision,
  type Meta,
} from '../core/decide.ts'
import {
  BoardError,
  EVENT_TYPES,
  OUTCOME_STATES,
  type AgentRef,
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
import { answerPrompt } from '../core/answer.ts'
import { HARNESSES, TERMINAL_EVENTS, attend, isHookEnvelope, observe, type Harness, type HookEnvelope } from '../integrations/hooks/observe.ts'
import { pullRequestNote } from '../integrations/github/pull-request.ts'
import { boardDir, pnyxHome, loadBoard, readEvents, repairBoard, spoolFiles, withWriter, type Writer } from '../store/board-store.ts'

const DEFAULT_BOARD = 'default'
const HISTORY_LIMIT = 20
const HISTORY_MAX = 100
const HOME_LIMIT = 50

export type Output = Record<string, unknown>
export type Options = NonNullable<ParseArgsConfig['options']>

export const COMMON: Options = { board: { type: 'string' } }
export const WRITE: Options = {
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

export function integer({ value, flag }: {
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
  const m: Meta = { at: new Date().toISOString(), actor: (values.actor as string | undefined) ?? (process.env.PNYX_ACTOR || 'cli') }

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

const HARVEST_AFTER = ['Stop', 'SubagentStop', 'PostCompact', 'SessionEnd']
const HOOKS = 'hooks'

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
  const task = typeof entry.task === 'string' ? entry.task : undefined
  const resolve = ({ key }: { key: string }) => (key.includes('/') ? key : joinedKey({ state: writer.state, key, folder, terminal, probed, task }))

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

    let pushed = decidePush({
      state: writer.state,
      key,
      input: attention ? {
        ...card,
        attention,
      } : card,
      meta: m,
    })

    if ('event' in pushed && o.card.agent) {
      const existing = Object.values(writer.state.sessions ?? {}).find(s => s.sourceRefs.some(r =>
        r.adapter === 'hooks' && `${r.instanceId}:${r.objectId}` === o.key))
      const previous = existing?.taskId ? writer.state.cards[existing.taskId] : undefined
      const target = writer.state.cards[writer.state.keys[key] ?? '']
      const replaced = target?.sessionIds?.[0]
      const moving = previous && previous.key !== key
        && previous.sourceRefs.some(r => r.adapter === 'firstmate')
      const incoming = sessionId({ agent: o.card.agent as AgentRef })
      const replacing = key !== o.key && replaced && replaced !== incoming

      if (moving || replacing) {
        const ref = moving ? existing!.id : replaced!
        harvestTranscripts({ writer, cardIds: [(moving ? previous : target)!.id], at: m.at })
        apply({
          decision: decideSession({
            state: writer.state, ref, task: null, meta: { ...m, id: `${m.id}:detach:${ref}` },
          }),
        })
        pushed = decidePush({
          state: writer.state, key, input: attention ? { ...card, attention } : card, meta: m,
        })
      }
    }

    apply({ decision: pushed })
    // Hooks own only the outcome they recorded on the session's own card: a joined
    // Firstmate task, or a Firstmate or manual outcome, keeps its own rule.
    const target = writer.state.cards[writer.state.keys[key] ?? '']
    const stale = 'skipped' in pushed && pushed.skipped === 'stale'
    const owned = !target?.sourceRefs.some(r => r.adapter === 'firstmate')
      && (!target?.outcome || target.outcome.source === HOOKS)

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

    const config = writer.state.board

    if (task === HYDRA_CARD && o.card.agent && config && !config.hydra.session) {
      const session = sessionId({ agent: o.card.agent as AgentRef })

      const recorded = writer.state.sessions?.[session]

      if (recorded && (!recorded.taskId || writer.state.cards[recorded.taskId]?.automaticTask)) {
        apply({ decision: hydraEvent({ state: writer.state, meta: { ...m, id: `${m.id}:hydra` }, cardId: '$board', change: { type: 'board.configured', data: { ...config, hydra: { ...config.hydra, session } } } }) })
      }
    }
  }

  return harvest
}

export function drainSpool({ writer }: {
  writer: Writer
}): { ingested: number; rejected: number; notes?: number } {
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

  const hydra = writer.state.board?.hydra.session

  const turned = [...harvest].flatMap(id => writer.state.cards[id] ?? [])

  if (hydra && turned.some(card => cardSessionId({ card }) === hydra)) {
    harvest.add(HYDRA_CARD)
  }

  const notes = harvest.size ? harvestTranscripts({
    writer,
    cardIds: harvest,
    at: new Date().toISOString(),
  }) : 0

  return { ingested, rejected, ...(notes ? { notes } : {}) }
}

export function ingestSpool({ board }: {
  board: string
}): { ingested: number; rejected: number; notes?: number } {
  return withWriter({ board, fn: ({ writer }) => drainSpool({ writer }) })
}

function receipt({ state, event }: { state: BoardState; event: BoardEvent }): Output {
  if (event.type === 'board.configured' || event.type === 'board.columns' || event.type === 'board.agents') {
    return {
      event: { seq: event.seq, id: event.id, type: event.type },
      board: state.board,
      revision: state.boardRevision,
    }
  }

  if (event.type === 'hydra.message') {
    return { event: { seq: event.seq, id: event.id, type: event.type }, message: event.id, hydra: event.data.hydra, state: 'queued', help: ['Hydra can read this in `pnyx-axi hydra messages`; no worker was launched'] }
  }

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
      state: replay({ state: emptyBoard(), events: events.slice(0, index + 1) }),
      event: original,
    }),
    duplicate: 'event id already applied; nothing appended',
  }
}

// A repeated --event-id answers with the original receipt before any other check,
// so a retry of a write that already landed never reports a conflict.
export function commit(
  { board, meta, intent, decide }: {
    board: string
    meta: Meta
    intent: Intent
    decide: ({ state, meta }: { state: BoardState; meta: Meta }) => Decision
  },
): Output {
  return withWriter({
    board,
    fn: ({ writer }) => {
      const spool = drainSpool({ writer })
      const seq = meta.id === undefined ? undefined : writer.state.eventIds[meta.id]
      let out: Output

      if (seq !== undefined) {
        out = originalReceipt({
          board,
          state: writer.state,
          id: meta.id!,
          seq,
          intent,
        })
      } else {
        let decision = decide({ state: writer.state, meta })

        if ('event' in decision && decision.event.type === 'task.session' && decision.event.data.before) {
          harvestTranscripts({ writer, cardIds: [decision.event.data.before], at: meta.at })
          decision = decide({ state: writer.state, meta: { ...meta, ifRevision: undefined } })
        }

        if ('event' in decision) {
          writer.append({ event: decision.event })
          out = receipt({ state: writer.state, event: decision.event })

          if (decision.event.type === 'task.session' && decision.event.data.after) {
            harvestTranscripts({
              writer,
              cardIds: [decision.event.data.after],
              at: meta.at,
            })
          }
        } else {
          out = { event: `none: ${decision.skipped}` }
        }
      }

      if (spool.ingested || spool.rejected) {
        out.spool = spool
      }

      return out
    },
  })
}

export function guard<T = Output>({ handler }: { handler: ({ args }: { args: string[] }) => T }) {
  const mapped = ({ error }: { error: unknown }): never => {
    if (error instanceof BoardError) {
      throw new AxiError(error.message, error.code, error.help)
    }

    throw error
  }

  return (args: string[]): T => {
    try {
      const result = handler({ args })

      return result instanceof Promise ? result.catch(error => mapped({ error })) as T : result
    } catch (error) {
      return mapped({ error })
    }
  }
}

function column({ value }: { value: string }): Column {
  return (value.startsWith('custom:') ? value : value.replace(/-/g, '_')) as Column
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

  detail.sessions = card.sessionIds?.length ? card.sessionIds : 'none'
  detail.visibility = card.hidden ? 'history' : 'board'

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
  const cards = Object.values(state.cards).filter(card => liveTask({ card }))
  const config = boardConfig({ state })
  const columns = Object.fromEntries(
    config.columns.map(c => [c.id, cards.filter(card => card.column === c.id).length]),
  )
  const server = await readServer({ board: DEFAULT_BOARD })
  const out: Output = { board: DEFAULT_BOARD, hydra: config.hydra.id, server: server ? `running at ${server.url}` : 'not running', columns }

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
    out.help = ['Run `pnyx-axi task create --title <title>` to add work', ...serveHint]

    return out
  }

  const order = ({ c }: { c: Card }) => config.columns.findIndex(column => column.id === c.column)
  const sorted = cards.sort((a, b) => order({
    c: a,
  }) - order({
    c: b,
  }) || rankOf({ card: a }) - rankOf({ card: b }))
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

function taskCommand({ args }: { args: string[] }): Output | Promise<Output> {
  const { values, positionals, board } = parse({
    args,
    options: {
      ...WRITE,
      title: { type: 'string' },
      key: { type: 'string' },
      folder: { type: 'string' },
      session: { type: 'string' },
      parent: { type: 'string' },
      column: { type: 'string' },
      note: { type: 'string' },
      limit: { type: 'string' },
      before: { type: 'string' },
      full: { type: 'boolean' },
      harness: { type: 'string' },
      prompt: { type: 'string' },
      'paseo-url': { type: 'string' },
      via: { type: 'string' },
      kind: { type: 'string' },
    },
    positionals: 3,
  })
  const action = positionals[0]
  const m = meta({ values })
  const url = values['paseo-url'] as string | undefined

  if (action === 'paseo') {
    return paseoStatus({ url })
  }

  if (action === 'start') {
    return startTask({
      board,
      task: required({ value: positionals[1], what: 'task id' }),
      via: values.via as string | undefined,
      kind: values.kind as string | undefined,
      harness: values.harness as string | undefined,
      prompt: values.prompt as string | undefined,
      folder: values.folder as string | undefined,
      url,
      meta: m,
    })
  }

  if (action === 'sessions') {
    const sessions = Object.values(loadBoard({ board }).state.sessions ?? {}).map(s => ({
      id: s.id, provider: s.agent.provider, task: s.taskId ?? 'none', interactive: interactive({ session: s }),
    }))

    return { sessions: sessions.length ? sessions : 'none: no sessions recorded' }
  }

  if (action === 'create') {
    const title = required({ value: values.title as string | undefined, what: '--title' }).trim()
    required({ value: title, what: '--title' })
    const key = values.key as string | undefined ?? `task:${m.id ?? randomUUID()}`

    if (key.startsWith('$')) {
      throw new BoardError({ message: 'task keys beginning with $ are reserved', code: 'VALIDATION_ERROR' })
    }

    const folder = canonical({ path: values.folder })

    return commit({
      board,
      meta: m,
      intent: { type: 'task.created', card: key },
      decide: ({ state }) => {
        if (state.keys[key]) {
          throw new BoardError({ message: `task key already exists: ${key}`, code: 'CONFLICT' })
        }

        const parent = values.parent ? findCard({ state, ref: String(values.parent) }) : undefined

        if (parent?.parentId || parent?.automaticTask || parent?.id === HYDRA_CARD) {
          throw new BoardError({ message: 'subtasks have one level under a task', code: 'VALIDATION_ERROR' })
        }

        const columns = boardConfig({ state, id: board }).columns
        const selected = values.column
          ? columns.find(c => c.id === values.column || c.title === values.column) : undefined

        if (values.column && !selected) {
          throw new BoardError({ message: 'unknown board column', code: 'VALIDATION_ERROR' })
        }

        return hydraEvent({ state, meta: m, cardId: `c${state.seq + 1}`, change: { type: 'task.created', data: { key, title, ...(folder ? { folder } : {}), ...(parent ? { parentId: parent.id } : {}), ...(selected ? { column: selected.id } : {}) } } })
      },
    })
  }

  if (action === 'list') {
    const state = loadBoard({ board }).state

    const tasks = Object.values(state.cards).filter(c => liveTask({ card: c }))
      .map(c => ({ ...cardRow({ card: c }), parent: c.parentId ?? '', status: c.status?.state ?? 'paused', worker: c.sessionIds?.[0] ?? '' }))

    return tasks.length
      ? { board, tasks, help: [`Run \`pnyx-axi task show <id> --board ${board}\` for one task`] }
      : { board, tasks: 'none: no tasks on this board', help: [`Run \`pnyx-axi task create --title <title> --board ${board}\` to add one`] }
  }

  if (action === 'history') {
    return taskHistory({ board, ref: required({ value: positionals[1], what: 'task id' }), before: integer({ value: values.before, flag: '--before' }), limit: integer({ value: values.limit, flag: '--limit' }) ?? HISTORY_LIMIT, full: Boolean(values.full) })
  }

  if (action === 'show') {
    const task = findCard({ state: loadBoard({ board }).state, ref: required({ value: positionals[1], what: 'task id' }) })

    if (values.full) {
      return { task }
    }

    return {
      task: { ...cardRow({ card: task }), key: task.key, parent: task.parentId ?? 'none', status: task.status ? `${task.status.state}${task.status.note ? `: ${task.status.note}` : ''}` : 'none: no declaration yet', worker: task.sessionIds?.[0] ?? 'none', declarations: task.statusLog?.length ?? 0, firstmate: task.mirror ? 'mirrored' : 'none' },
      help: [`Run \`pnyx-axi task show ${task.id} --full --board ${board}\` for the full record, or \`pnyx-axi task history ${task.id} --board ${board}\` for its events`],
    }
  }

  if (action === 'chat') {
    const state = loadBoard({ board }).state
    const task = findCard({ state, ref: required({ value: positionals[1], what: 'task id' }) })
    const session = values.session ? findSession({ state, ref: String(values.session) }) : undefined

    if (session && !taskSessions({ board, ids: new Set([task.id]) }).has(session.id)) {
      throw new BoardError({ message: 'this session has no recorded membership on the task', code: 'NOT_FOUND' })
    }

    const card = session ? { ...task, agent: session.agent, sessionIds: [session.id] } : task

    return {
      thread: readThread({
        board, state, card, homes: [], before: values.before as string | undefined,
      }),
    }
  }

  if (action === 'status') {
    const ref = required({ value: positionals[1], what: 'task id' })

    return commit({ board, meta: m, intent: { type: 'task.declared', card: ref }, decide: ({ state }) => declareTask({ state, ref, status: required({ value: positionals[2], what: 'status' }), note: String(values.note ?? ''), meta: m }) })
  }

  if (action === 'rename') {
    const ref = required({ value: positionals[1], what: 'task id' })

    return commit({ board, meta: m, intent: { type: 'card.pushed', card: ref }, decide: ({ state }) => decidePush({ state, key: findCard({ state, ref }).key, input: { title: required({ value: values.title as string, what: '--title' }) }, meta: m }) })
  }

  if (action !== 'attach' && action !== 'detach') {
    throw new AxiError('Use task create, list, show, status, history, rename, start, paseo, sessions, attach or detach', 'VALIDATION_ERROR')
  }

  const ref = required({ value: positionals[1], what: 'task id' })

  return commit({
    board,
    meta: m,
    intent: { type: 'task.session', card: ref },
    decide: ({ state, meta: current }) => {
      if (!liveTask({ card: findCard({ state, ref }) })) {
        throw new BoardError({ message: 'choose an explicit task; use board set to configure Hydra', code: 'VALIDATION_ERROR' })
      }

      if (action === 'detach' && !findCard({ state, ref }).sessionIds?.length) {
        return { skipped: 'unchanged' }
      }

      const session = action === 'attach'
        ? sessionRef({ state, ref: required({ value: values.session as string | undefined, what: '--session' }) })
        : findSession({ state, ref }).id

      return decideSession({ state, ref: session, task: action === 'attach' ? ref : null, meta: current })
    },
  })
}

const task = guard({ handler: ({ args }) => taskCommand({ args }) })

function sessionRef({ state, ref }: { state: BoardState; ref: string }): string {
  return ref === 'self'
    ? selfSession({
      state,
      here: {
        paseoTerminal: process.env.PASEO_TERMINAL_ID,
        tmuxPane: process.env.TMUX_PANE,
        herdrPane: process.env.HERDR_PANE_ID,
      },
    }).id
    : ref
}

function taskHistory({ board, ref, before, limit, full }: {
  board: string
  ref: string
  before?: number
  limit: number
  full: boolean
}): Output {
  if (limit < 1 || limit > HISTORY_MAX) {
    throw new BoardError({ message: `limit must be 1–${HISTORY_MAX}`, code: 'VALIDATION_ERROR' })
  }

  const state = loadBoard({ board }).state
  const task = findCard({ state, ref })
  const ids = new Set([task.id, ...Object.values(state.cards).filter(c => c.parentId === task.id)
    .map(c => c.id)])
  const events = readEvents({ board })
  const sessions = taskSessions({ board, ids })
  const matches = events.filter(e => (before === undefined || e.seq < before) && (ids.has(e.cardId) || (e.type === 'task.session' && (ids.has(e.data.before ?? '') || ids.has(e.data.after ?? ''))) || (e.type === 'hydra.message' && ids.has(e.data.task ?? ''))))
    .reverse()
  const page = matches.slice(0, limit)

  const help = [
    ...(matches.length > limit ? [`Run \`pnyx-axi task history ${ref} --before ${page.at(-1)!.seq} --board ${board}\` for older events`] : []),
    ...(full || !page.length ? [] : [`Run \`pnyx-axi task history ${ref} --full --board ${board}\` for each event's data`]),
  ]

  return {
    board,
    task: task.id,
    sessions: sessions.size ? [...sessions].map(id => ({ session: id, transcript: state.sessions?.[id]?.agent.transcriptPath ?? 'unavailable', command: `pnyx-axi task chat ${task.id} --session ${id} --board ${board}` })) : 'none: no agent has worked on this task',
    events: page.length ? page.map(e => ({ seq: e.seq, id: e.id, at: e.at, type: e.type, card: e.cardId, actor: e.actor, summary: summarize({ event: e }), ...(full ? { data: e.data } : {}) })) : 'none: no matching events',
    ...(matches.length > limit ? { next: page.at(-1)!.seq } : {}),
    ...(help.length ? { help } : {}),
  }
}

function taskSessions({ board, ids }: { board: string; ids: Set<string> }): Set<string> {
  const sessions = new Set<string>()

  for (const event of readEvents({ board })) {
    if (event.type === 'task.session' && (ids.has(event.data.before ?? '') || ids.has(event.data.after ?? ''))) {
      sessions.add(event.data.session)
    }

    if (ids.has(event.cardId) && event.type === 'card.pushed' && event.data.agent) {
      const agent = event.data.agent
      sessions.add(`${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}`)
    }
  }

  return sessions
}

function boardCommand({ args }: { args: string[] }): Output {
  const { values, positionals, board } = parse({ args, options: { ...WRITE, name: { type: 'string' }, hydra: { type: 'string' }, session: { type: 'string' }, firstmate: { type: 'string' }, command: { type: 'string' }, base: { type: 'string' } }, positionals: 2 })
  const action = positionals[0]

  if (action === 'homes') {
    return firstmateHomes({ base: values.base as string | undefined })
  }

  if (action === 'list') {
    let boards: string[] = []

    try {
      boards = readdirSync(join(pnyxHome(), 'boards'), { withFileTypes: true }).filter(d => d.isDirectory())
        .map(d => d.name)
    } catch { /* No boards have been created. */ }

    if (!boards.length) {
      return { boards: 'none: no boards yet', help: ['Run `pnyx-axi board create <id>` to add one'] }
    }

    return {
      boards: boards.map(id => {
        const state = loadBoard({ board: id }).state
        const config = boardConfig({ state, id })

        const tasks = Object.values(state.cards).filter(c => liveTask({ card: c })).length

        return { id, name: config.name, hydra: config.hydra.id, kind: config.hydra.kind, tasks }
      }),
      help: ['Run `pnyx-axi board show --board <id>` for its columns and Hydra'],
    }
  }

  const id = action !== 'create' ? board
    : positionals[1] ?? (values.firstmate ? homeBoardId({ home: String(values.firstmate) }) : required({ value: undefined, what: 'board id' }))
  boardDir({ board: id })

  if (action === 'show') {
    const state = loadBoard({ board: id }).state

    return { board: boardConfig({ state, id }), revision: state.boardRevision ?? 0 }
  }

  if (action !== 'create' && action !== 'set') {
    throw new BoardError({ message: 'Use board create <id>, list, homes, show or set', code: 'VALIDATION_ERROR' })
  }

  const m = meta({ values })

  return commit({
    board: id,
    meta: m,
    intent: { type: 'board.configured', card: '$board' },
    decide: ({ state }) => {
      if (action === 'create' && state.configured) {
        throw new BoardError({ message: `board already exists: ${id}`, code: 'CONFLICT' })
      }

      const current = boardConfig({ state, id })
      const identity = String(values.hydra ?? current.hydra.id)
      required({ value: identity.trim(), what: '--hydra identity' })
      const kept = identity === current.hydra.id ? current.hydra : undefined
      const home = canonical({ path: values.firstmate })

      if (values.firstmate && !home) {
        throw new BoardError({ message: '--firstmate must be an absolute home path', code: 'VALIDATION_ERROR' })
      }

      const session = values.session ? findSession({
        state,
        ref: sessionRef({ state, ref: String(values.session) }),
      }) : undefined

      if (session && session.taskId && !state.cards[session.taskId]?.automaticTask) {
        throw new BoardError({ message: 'detach the task worker before making it Hydra', code: 'CONFLICT' })
      }

      const hydra: HydraIdentity = { name: 'Hydra', kind: 'agent', ...kept, id: identity, ...(home ? { kind: 'firstmate', home } : {}), ...(session ? { session: session.id } : {}) }

      const command = values.command === undefined ? current.command : String(values.command).trim()
      const data: BoardConfig = { ...current, id, name: String(values.name ?? current.name), hydra }
      delete data.command

      if (command) {
        data.command = command
      }

      return hydraEvent({ state, meta: m, cardId: '$board', change: { type: 'board.configured', data } })
    },
  })
}

function homeBoardId({ home }: { home: string }): string {
  return basename(home).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64) || 'firstmate'
}

function firstmateHomes({ base }: { base?: string }): Output {
  const root = base ?? process.env.FIRSTMATE_FACTORY_BASE ?? join(homedir(), 'projects', 'agentic-engineering-workflow')
  let names: string[] = []

  try {
    names = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())
      .map(d => d.name)
  } catch { /* No such folder: no homes. */ }

  const homes = names.map(name => join(root, name)).filter(path =>
    ['state', 'config'].every(dir => existsSync(join(path, dir))) && existsSync(join(path, 'bin', 'fm-send.sh')))
  let boards: { id: string; home?: string }[] = []

  try {
    boards = readdirSync(join(pnyxHome(), 'boards')).map(id => ({ id, home: loadBoard({ board: id }).state.board?.hydra.home }))
  } catch { /* No boards yet. */ }

  if (!homes.length) {
    return { base: root, homes: 'none: no Firstmate homes found', help: ['Pass --base <folder holding the homes>'] }
  }

  const rows = homes.map(home => {
    const real = canonical({ path: home }) ?? home
    const board = boards.find(b => b.home === real)?.id

    return { home: real, board: board ?? 'none', ...(board ? {} : { create: `pnyx-axi board create --firstmate ${real}` }) }
  })

  return { base: root, homes: rows, help: ['Each home gets its own board; run the create command of a home without one'] }
}

const boardCommandHandler = guard({ handler: ({ args }) => boardCommand({ args }) })

function columnCommand({ args }: { args: string[] }): Output {
  const { values, positionals, board } = parse({ args, options: { ...WRITE, title: { type: 'string' }, id: { type: 'string' }, to: { type: 'string' }, before: { type: 'string' } }, positionals: 2 })
  const action = positionals[0]

  if (action === 'list') {
    const state = loadBoard({ board }).state

    return {
      columns: boardConfig({ state, id: board }).columns,
      revision: state.boardRevision ?? 0,
    }
  }

  const m = meta({ values })

  return commit({
    board,
    meta: m,
    intent: { type: 'board.columns', card: '$board' },
    decide: ({ state }) => {
      const before = structuredClone(boardConfig({ state, id: board }).columns)
      let columns = structuredClone(before)
      const ref = positionals[1]
      const selected = columns.find(c => c.id === ref)

      if (action !== 'create' && !selected) {
        throw new BoardError({ message: `column not found: ${ref}`, code: 'NOT_FOUND' })
      }

      let fallback: Column | undefined

      if (action === 'create') {
        const id = String(values.id ?? `custom:${(m.id ?? randomUUID()).toLowerCase()}`)

        if (!/^custom:[a-z0-9-]{1,60}$/.test(id)) {
          throw new BoardError({ message: 'new column ids use custom:<letters-digits-dashes>', code: 'VALIDATION_ERROR' })
        }

        columns.push({ id: id as Column, title: required({ value: values.title as string, what: '--title' }) })
      } else if (action === 'rename') {
        selected!.title = required({ value: values.title as string, what: '--title' })
      } else if (action === 'delete') {
        columns = columns.filter(c => c.id !== ref)
        fallback = values.to ? columns.find(c => c.id === values.to)?.id : columns[0]?.id

        if (values.to && !fallback) {
          throw new BoardError({ message: 'fallback column not found', code: 'VALIDATION_ERROR' })
        }
      } else if (action === 'reorder') {
        columns = columns.filter(c => c.id !== ref)
        const index = values.before
          ? columns.findIndex(c => c.id === values.before)
          : columns.length

        if (index < 0) {
          throw new BoardError({ message: '--before column not found', code: 'VALIDATION_ERROR' })
        }

        columns.splice(index, 0, selected!)

        if (columns.every((c, i) => c.id === before[i]!.id)) {
          return { skipped: 'unchanged' }
        }
      } else {
        throw new BoardError({ message: 'Use column list, create, rename, delete or reorder', code: 'VALIDATION_ERROR' })
      }

      validateColumns({ columns })
      const gone = ({ id }: { id?: Column }) =>
        id !== undefined && !columns.some(column => column.id === id)
      const placements = Object.fromEntries(Object.values(state.cards)
        .filter(c => gone({ id: c.column }))
        .map(c => [c.id, { before: c.column, after: fallback ?? columns[0]!.id }]))

      return hydraEvent({ state, meta: m, cardId: '$board', change: { type: 'board.columns', data: { columns, before, placements, ...(fallback ? { fallback } : {}) } } })
    },
  })
}

const columnCommandHandler = guard({ handler: ({ args }) => columnCommand({ args }) })

function hydraCommand({ args }: { args: string[] }): Output | Promise<Output> {
  const { values, positionals, board } = parse({ args, options: { ...WRITE, task: { type: 'string' }, action: { type: 'string' }, text: { type: 'string' }, after: { type: 'string' }, limit: { type: 'string' }, full: { type: 'boolean' }, via: { type: 'string' }, kind: { type: 'string' }, harness: { type: 'string' }, prompt: { type: 'string' }, folder: { type: 'string' }, home: { type: 'string' }, 'paseo-url': { type: 'string' } }, positionals: 1 })

  if (positionals[0] === 'start') {
    return startHydra({
      board,
      via: values.via as string | undefined,
      kind: values.kind as string | undefined,
      harness: values.harness as string | undefined,
      prompt: values.prompt as string | undefined,
      folder: values.folder as string | undefined,
      home: values.home as string | undefined,
      url: values['paseo-url'] as string | undefined,
      meta: meta({ values }),
    })
  }

  if (positionals[0] === 'messages') {
    const state = loadBoard({ board }).state
    const after = integer({ value: values.after, flag: '--after' }) ?? 0
    const limit = Math.min(integer({ value: values.limit, flag: '--limit' }) ?? HISTORY_LIMIT, HISTORY_MAX)

    if (limit < 1) {
      throw new BoardError({ message: '--limit must be positive', code: 'VALIDATION_ERROR' })
    }

    const events = readEvents({ board }).filter((e): e is Extract<BoardEvent, { type: 'hydra.message' }> => e.seq > after && e.type === 'hydra.message')
    const page = events.slice(0, limit)

    const through = page.at(-1)?.seq ?? after

    return {
      hydra: boardConfig({ state, id: board }).hydra.id,
      messages: page.length
        ? page.map(e => (values.full ? e : { seq: e.seq, id: e.id, at: e.at, actor: e.actor, task: e.data.task ?? 'none', action: e.data.action, text: e.data.text }))
        : `none: no messages after seq ${after}`,
      through,
      ...(events.length > limit ? { help: [`Run \`pnyx-axi hydra messages --after ${through} --board ${board}\` for the next page`] } : { help: [`Run \`pnyx-axi hydra messages --after ${through} --board ${board}\` later for new messages`] }),
    }
  }

  if (positionals[0] !== 'send') {
    throw new BoardError({ message: 'Use hydra send --text <message>, hydra send --task <id> [--action send|worker] or hydra messages', code: 'VALIDATION_ERROR' })
  }

  const m = meta({ values })

  const ref = values.task === undefined ? undefined : required({ value: values.task as string, what: '--task' })

  if (!ref && values.action !== undefined) {
    throw new BoardError({ message: '--action needs --task', code: 'VALIDATION_ERROR' })
  }

  return commit({
    board,
    meta: m,
    intent: { type: 'hydra.message', card: ref ?? '$board' },
    decide: ({ state }) => {
      const task = ref ? findCard({ state, ref }) : undefined

      if (task && !liveTask({ card: task })) {
        throw new BoardError({ message: 'choose a task, not an unassigned session', code: 'VALIDATION_ERROR' })
      }

      const action = String(values.action ?? 'send')

      if (action !== 'send' && action !== 'worker') {
        throw new BoardError({ message: '--action must be send or worker', code: 'VALIDATION_ERROR' })
      }

      const text = task
        ? String(values.text ?? `${action === 'worker' ? 'Create a worker for' : 'Work with me on'} task ${task.id}: ${task.title}. Read its task history and current record before continuing.`)
        : required({ value: values.text as string | undefined, what: '--text' })
      const decision = hydraEvent({ state, meta: m, cardId: task?.id ?? '$board', change: { type: 'hydra.message', data: { ...(task ? { task: task.id } : {}), action, text, hydra: boardConfig({ state, id: board }).hydra.id } } })

      if ('event' in decision) {
        decision.event.messageId = decision.event.id
      }

      return decision
    },
  })
}

const hydraCommandHandler = guard({ handler: ({ args }) => hydraCommand({ args }) })

const NOTES_SHOWN = 3
const NOTE_CUT = 280
const NOTE_SECTIONS = { summary: 'summary', decision: 'decisions', context: 'context' } as const

function cardNotes({ board, card, full }: {
  board: string
  card: Card
  full: boolean
}): { notes: Output; cut: boolean } {
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

    const asking = found.attention.find(request => answerPrompt({ card: found, request }))

    if (asking) {
      help.unshift(`Run \`pnyx-axi reply ${found.id} --answer ${asking.key} --json <answer>\` to answer its ${asking.kind} (see \`pnyx-axi reply --help\`)`)
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
    const { values, positionals, board } = parse({ args, options: { ...WRITE, before: { type: 'string' } }, positionals: 2 })
    const m = meta({ values })
    const ref = required({ value: positionals[0], what: 'card id' })
    const target = column({ value: required({ value: positionals[1], what: 'column' }) })
    const before = values.before as string | undefined

    return commit({ board, meta: m, intent: { type: 'card.moved', card: ref }, decide: ({ state }) => decideMove({ state, ref, column: target, before, meta: m }) })
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

export function summarize({ event }: { event: BoardEvent }): string {
  const undo = event.undoes ? `undo ${event.undoes}: ` : ''

  switch (event.type) {
    case 'chat.message': return `${event.data.role}: ${event.data.text}`
    case 'board.configured': return `Board ${event.data.name}; Hydra ${event.data.hydra.id}`
    case 'board.columns': return `Columns: ${event.data.columns.map(c => c.title).join(', ')}`
    case 'task.created': return `Created ${event.data.parentId ? 'subtask' : 'task'}: ${event.data.title}`
    case 'task.declared': return `${event.data.state}: ${event.data.note}`
    case 'task.mirrored': return `Mirrored Firstmate task ${event.data.task}`
    case 'hydra.message': return `${event.data.action === 'worker' ? 'Create a worker' : 'Send to Hydra'}: ${event.data.text}`
    case 'board.agents': return `Agent kinds: ${Object.keys(event.data.agents).join(', ') || 'none'}`
    case 'task.session': return `${undo}session ${event.data.session}: ${event.data.before ?? 'none'} -> ${event.data.after ?? 'none'}`
    case 'board.view': return 'View preferences changed'
    case 'card.pushed':
      return `${undo}${Object.keys(event.data).filter(k => k !== 'key' && k !== 'before')
        .join(' ') || 'no fields'}`
    case 'card.moved':
      return `${undo}${event.data.before ?? 'none'} -> ${event.data.after ?? 'none'}`
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
      full: { type: 'boolean' },
    }
    const { values, board } = parse({ args, options, positionals: 0 })
    const limit = Math.min(integer({ value: values.limit, flag: '--limit' }) ?? HISTORY_LIMIT, HISTORY_MAX)
    const before = integer({ value: values.before, flag: '--before' })
    const kind = values.kind as string | undefined
    const type = kind && (kind.includes('.') ? kind : `card.${kind}`)

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
        ...(values.full ? { data: e.data } : {}),
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
        intent: { type: target.type, card: target.cardId },
        decide: ({ state, meta: current }) => decideUndo({ state, target, meta: current }),
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
    const options: Options = { ...WRITE, harness: { type: 'string' }, remove: { type: 'boolean' }, preview: { type: 'boolean' }, home: { type: 'string' } }
    const { values, positionals, board } = parse({ args, options, positionals: 1 })

    if (positionals[0] === 'hydra') {
      return setupHydra({ board, home: required({ value: values.home as string | undefined, what: '--home' }), meta: meta({ values }) })
    }

    if (positionals[0] !== 'hooks') {
      throw new AxiError(`unknown setup target: ${positionals[0] ?? '(none)'}`, 'VALIDATION_ERROR', ['Run `pnyx-axi setup hooks` or `pnyx-axi setup hydra --home <firstmate home>`'])
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
  board: boardCommandHandler,
  column: columnCommandHandler,
  hydra: hydraCommandHandler,
  task,
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
description: Task boards, each with one Hydra orchestrator
commands:
  pnyx-axi                                   Show the board summary
  board create|list|homes|show|set            Configure boards, one per Firstmate home, each with one Hydra
  column create|rename|delete|reorder|list    Edit the column template
  task create|list|show|rename|status|history Tasks and one level of subtasks (--parent <id>)
  task start <task> [--via paseo|firstmate|command] [--kind <kind>]  Start a worker for the task and attach it
  hydra start|send|messages|check            Start the board's Hydra, queue task context in its chat, read it, or wait for changes
  kind list|set|remove                       The agent (harness, model, effort, mode, quota) each task kind starts on
  task sessions                              List recorded sessions, including background runs
  task attach <task> --session <session>      Move an interactive session onto a task
  task detach <task>                         Detach its agent without stopping the session
  push --key <key> --file <card.json|->      Create or update the card with this key
  card <id|key> [--full]                     Show one card with its summary, decisions and context
  harvest [--card <id>]                      Collect summaries and decisions sources already recorded
  move <id> <column> [--before <id>]         Put a card in a column, above another card or at its end
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
  setup hydra --home <firstmate home>        Make a Firstmate home the board's Hydra and give it the pnyx-hydra skill
  integrations                               Show which integrations are ready and how to set each up
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
  board: `usage: pnyx-axi board create <id> [--name <name>] [--hydra <identity>] [--session <session>] [--firstmate <home>]
pnyx-axi board create --firstmate <home>
pnyx-axi board list
pnyx-axi board homes [--base <folder>]
pnyx-axi board show|set --board <id> [--hydra <identity>] [--session <session>] [--firstmate <home>] [--command <shell>]
Each board has exactly one Hydra identity. Changing Hydra preserves tasks, history and old messages.
--session self picks the session running in the caller's own Paseo terminal, tmux pane or Herdr pane. No process is launched. A session used as Hydra cannot also be a task worker.
board create --firstmate names the board after the home's folder. board homes lists the Firstmate homes
in --base (FIRSTMATE_FACTORY_BASE, default ~/projects/agentic-engineering-workflow) and each one's board.
--command sets the shell command task start --via command and hydra start --via command run; an empty value clears it.
`,
  column: `usage: pnyx-axi column list
pnyx-axi column create --title <title> [--id custom:<id>]
pnyx-axi column rename <id> --title <title>
pnyx-axi column delete <id> [--to <remaining-column>]
pnyx-axi column reorder <id> [--before <id>]
All columns, including template columns, can be edited. Deletion moves cards to the fallback;
the final column cannot be deleted. Use --if-revision for the board revision.
`,
  hydra: `usage: pnyx-axi hydra send --task <id> [--action send|worker] [--text <message>]
pnyx-axi hydra send --text <message>
pnyx-axi hydra messages [--after <seq>] [--limit <n>] [--full]
pnyx-axi hydra check [--after <seq>] [--wait <seconds>]
pnyx-axi hydra start [--via paseo|command] [--kind <kind>] [--harness claude|codex] [--prompt <text>] [--folder <path>] [--paseo-url <url>]
pnyx-axi hydra start --via firstmate --home <firstmate home>
hydra start starts the board's Hydra: in Paseo (Claude Code by default) or with the board command, its
session becomes the board's Hydra (in Paseo on the hydra kind's agent unless --kind names another); a Firstmate home becomes Hydra as \`setup hydra\` makes it. The default
prompt points Hydra at the pnyx-hydra skill.
Messages are durable entries in Hydra's board chat; one without --task is about the board, not a task. No worker is launched or native terminal typed into.
Hydra reads messages and task history through AXI. --after is an event sequence cursor.
check is Hydra's light check: it lists only what Hydra tracks (messages, task creation, declarations, attachments, columns, moves, links) after --after (default: now), skipping Hydra's own writes (actor hydra),
and with --wait it blocks up to that many seconds until one appears. Pass the printed through as the next --after.
`,
  task: `usage: pnyx-axi task create --title <title> [--key <key>] [--folder <path>] [--column <id>] [--parent <task>]
pnyx-axi task list | show <id> [--full]
pnyx-axi task rename <id> --title <title>
pnyx-axi task status <id> working|needs_you|paused|blocked|done [--note <text>]
pnyx-axi task history <id> [--before <seq>] [--limit <n>] [--full]
pnyx-axi task chat <id> [--session <past-or-current-session>] [--before <cursor>]
pnyx-axi task start <task> [--via paseo] [--kind <kind>] [--harness claude|codex] [--prompt <text>] [--folder <path>] [--paseo-url <url>]
pnyx-axi task start <task> --via firstmate [--prompt <text>]
pnyx-axi task start <task> --via command [--prompt <text>] [--harness <name>] [--folder <path>]
pnyx-axi task paseo [--paseo-url <url>]
pnyx-axi task sessions
pnyx-axi task attach <task> --session <session-id|card-id|key|self>
pnyx-axi task detach <task>
Tasks accept one attached session. A second session cannot replace the recipient.
attach moves an interactive session to the task; an occupied destination is rejected.
detach removes the attachment without stopping the session; it stays in task sessions and History.
attach and detach never start, stop or type into a process. Writes accept --if-revision and --event-id.
task start asks the local Paseo daemon (PNYX_PASEO_URL, default ws://127.0.0.1:6767/ws) to start a
Claude Code or Codex agent in the task's folder with the opening message, then attaches it. --folder
also records the task's folder. Replies and the conversation then go through Paseo; the agent stays
in Paseo too. Repeating the same --event-id never starts a second agent. task paseo checks the daemon.
--kind picks the agent (see pnyx-axi kind; default: the default kind, else Claude Code); --harness overrides its harness and
--prompt its opening message, which otherwise names the task and the pnyx-worker skill.
--via firstmate puts a worker request in Hydra's chat and sends it to the board's Firstmate home as an inbox note.
--via command runs the board command in the task's folder with PNYX_TASK and the rest of its context in the
environment; the session it starts attaches to the task when its hooks first report.
The default route is firstmate for a board whose Hydra is a Firstmate home, otherwise paseo.
`,
  push: `usage: pnyx-axi push --key <key> --file <card.json|-> [--event-id <id>] [--if-revision <n>] [--actor <who>] [--reason <text>]
Creates or updates the card with this key. Repeating the same push, or the same --event-id, appends nothing.
card.json fields (all optional): title, autoTitle {from: session|prompt|agent|folder, text} (used only while no title is set), workspace, tags[], parent (card id or key, null to clear), activity,
  agent {provider, sessionId, agentId, agentType, cwd, transcriptPath}, attention[] {kind, key, blocking, text, questions[] {question, header, options[] {label, description}, multiSelect}, form[] {name, title, type, options[], required}, answered},
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
  move: `usage: pnyx-axi move <id> <column-id> [--before <id>] [--event-id <id>] [--if-revision <n>] [--reason <text>]
Puts the card in the column just above the --before card, or at the end of the column without it.
Cards never move on their own: a card stays where it was created or last moved. Columns come from \`pnyx-axi column list\`.
`,
  link: `usage: pnyx-axi link <id> --url <url> [--kind github_pr|linear|url] [--number <n>] [--title <text>] [--state open|merged|closed] [--remove] [--event-id <id>] [--if-revision <n>]
GitHub pull request URLs get kind and number filled in. A link never moves the card.
`,
  outcome: `usage: pnyx-axi outcome <id> done|failed|cancelled [--note <text>] | --clear [--event-id <id>] [--if-revision <n>]
`,
  history: `usage: pnyx-axi history [--card <id>] [--kind pushed|moved|linked|outcome|replied|noted] [--workspace <name>] [--before <seq>] [--limit <n>] [--full]
Newest first, ${HISTORY_LIMIT} per page (max ${HISTORY_MAX}).
`,
  undo: `usage: pnyx-axi undo <event-id> [--event-id <id>] [--if-revision <n>]
Appends an event that reverses a manual push edit, move, link or outcome. Refused when the card changed since.
Source observations, card creation and merges cannot be undone.
`,
  setup: `usage: pnyx-axi setup hooks [--harness claude|codex] [--remove] [--preview]
pnyx-axi setup hydra --home <firstmate home> [--board <id>]
Adds Pnyx's reporting hook to the user-level Claude Code settings.json or Codex hooks.json, keeping
every other hook. Without --harness it sets up each harness whose config folder exists. Rerunning
changes nothing; --remove takes out only Pnyx's entries. The hooks print nothing and always exit 0,
so they never add to the agent's context: no session-start board summary is installed.
Hook events go to the default board, or to PNYX_HOME and PNYX_BOARD when a session has them.
setup hydra makes the Firstmate home the board's Hydra, copies the pnyx-hydra skill into the home's
.agents/skills (kept out of the clone through .git/info/exclude) and leaves Firstmate an inbox note about it.
Firstmate's own files are not changed.
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
Commands go over the same socket: {"type":"command","id":"<id>","name":"move|link|outcome|undo|kind","args":[...]}
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
