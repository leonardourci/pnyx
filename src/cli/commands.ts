import { mentionContext } from '../mentions/mentions.ts'
import { reminderTime } from '../reminders/time.ts'
import { waitingReminders } from '../reminders/state.ts'
import { findProject, projectRows, taskProject } from '../projects/read.ts'
import { MAX_DONE_HOURS } from '../core/retention.ts'
import { hideDone } from '../store/retention.ts'
import { setupService } from '../server/service.ts'
import { setupSkills } from '../integrations/skills/install.ts'
import { DEFAULT_VIEW, DEFAULT_WIDTHS, resetLayoutWidths, viewFor } from '../core/view.ts'
import { createHash, randomUUID } from 'node:crypto'
import { sendReply } from './reply.ts'
import { findSession, interactive, liveTask, rankOf, selfSession } from '../core/tasks.ts'
import { paseoStatus } from '../integrations/paseo/launch.ts'
import { setupHydra, startHydra, startTask } from './start.ts'
import { copyCommand } from '../copies/cli.ts'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { hydraConfig, declareTask, hydraEvent, HYDRA_CARD, LOCKED_DELETE, lockedColumn, validateColumns } from '../core/hydra.ts'
import type { HydraConfig, HydraIdentity } from '../core/model.ts'
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
  parseLink,
  type Decision,
  type Meta,
} from '../core/decide.ts'
import {
  HydraError,
  EVENT_TYPES,
  HYDRA_ACTOR,
  OUTCOME_STATES,
  type HydraEvent,
  type HydraState,
  type Card,
  type EventType,
  type Column,
  type NotedEvent,
  type OutcomeState,
} from '../core/model.ts'
import { emptyHydra, replay } from '../core/reducer.ts'
import { askHost, readServer } from '../server/state.ts'
import { detectedHarnesses, setupHooks } from '../integrations/hooks/install.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { appendNote, harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { answerPrompt } from '../core/answer.ts'
import { HARNESSES, type Harness } from '../integrations/hooks/observe.ts'
import { pullRequestNote } from '../integrations/github/pull-request.ts'
import { canonical } from '../store/paths.ts'
import { hydraDir, hydraIds, loadHydra, readEvents, repairHydra, spoolFiles, withWriter, type Writer } from '../store/hydra-store.ts'

const DEFAULT_HYDRA = 'default'
const HISTORY_LIMIT = 20
const HISTORY_MAX = 100
const HOME_LIMIT = 50
// Hydra's own changes to tasks carry one short why; the owner's direct actions need none.
const EXPLAINED: readonly EventType[] = ['card.moved', 'task.created', 'task.brief', 'task.visibility', 'task.reminder']

export type Output = Record<string, unknown>
export type Options = NonNullable<ParseArgsConfig['options']>

export const COMMON: Options = { hydra: { type: 'string' } }
export const WRITE: Options = {
  ...COMMON,
  actor: { type: 'string' },
  reason: { type: 'string' },
  details: { type: 'string' },
  'event-id': { type: 'string' },
  'if-revision': { type: 'string' },
  confirm: { type: 'string' },
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
    hydraId: (values.hydra as string | undefined) ?? DEFAULT_HYDRA,
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

  if (typeof values.details === 'string' && values.details.trim()) {
    m.details = values.details
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

// Returns the trimmed reason, which is empty only for writes that are not Hydra's.
export function explained({ meta }: { meta: Meta }): string {
  const reason = meta.reason?.trim() ?? ''

  if (meta.actor === HYDRA_ACTOR && !reason) {
    throw new HydraError({ message: 'Hydra changes need --reason <why>', code: 'VALIDATION_ERROR', help: ['Repeat the command with --reason "<one short line on why>"; Pnyx keeps it on the event and posts it in your Hydra’s chat'] })
  }

  return reason
}

// An ordinary Hydra message, so the light check, hydra messages and later sessions read it back.
export function postLine({ writer, hydraId, meta, cardId, action, reason, id }: {
  writer: Writer
  hydraId: string
  meta: Meta
  cardId: string
  action: string
  reason: string
  id?: string
}): string {
  const text = `${action}: ${reason}`

  if (id && id in writer.state.eventIds) {
    return text
  }

  const decision = hydraEvent({ state: writer.state, meta: { at: meta.at, actor: meta.actor, ...(id ? { id } : {}) }, cardId, change: { type: 'hydra.message', data: { task: cardId, action: 'send', text, ...(meta.details ? { details: meta.details } : {}), hydra: hydraConfig({ state: writer.state, id: hydraId }).hydra.id } } })

  if ('event' in decision) {
    decision.event.messageId = decision.event.id
    writer.append({ event: decision.event })
  }

  return text
}

function actionText({ state, hydraId, event }: {
  state: HydraState
  hydraId: string
  event: HydraEvent
}): string {
  const title = state.cards[event.cardId]?.title ?? event.cardId
  const columnTitle = ({ id }: { id: Column | null }) => hydraConfig({ state, id: hydraId }).columns.find(c => c.id === id)?.title ?? id ?? 'none'

  switch (event.type) {
    case 'card.moved': return event.undoes ? `Moved ${title} back to ${columnTitle({ id: event.data.after })}` : event.data.before === event.data.after ? `Reordered ${title} in ${columnTitle({ id: event.data.after })}` : `Moved ${title} to ${columnTitle({ id: event.data.after })}`
    case 'task.created': return `Created ${title}`
    case 'task.brief': return `Updated the brief of ${title}`
    case 'task.visibility': return event.data.after ? `Hid ${title}` : `Returned ${title} to the Hydra`
    default: return summarize({ event })
  }
}

function receipt({ state, event }: { state: HydraState; event: HydraEvent }): Output {
  if (event.type === 'hydra.project') {
    return {
      event: { seq: event.seq, id: event.id, type: event.type },
      project: event.data.after,
      revision: state.projectsRevision,
    }
  }

  if (event.type === 'hydra.memory') {
    return { event: { seq: event.seq, id: event.id, type: event.type }, memory: event.data.key, state: event.data.after === null ? 'forgotten' : 'saved' }
  }

  if (event.type === 'board.configured' || event.type === 'board.columns' || event.type === 'board.agents') {
    return {
      event: { seq: event.seq, id: event.id, type: event.type },
      hydra: state.config,
      revision: state.configRevision,
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

function confirmationPreview({ state, event }: { state: HydraState; event: HydraEvent }): Output {
  if (event.type === 'hydra.project') {
    return { project: event.data.after, hydras: event.data.sharedWith }
  }

  if (event.type === 'card.moved') {
    return {
      task: event.cardId,
      title: state.cards[event.cardId]?.title,
      from: event.data.before,
      to: event.data.after,
      rank: event.data.rank,
    }
  }

  if (event.type === 'board.columns') {
    const { columns, placements, fallback } = event.data
    const before = hydraConfig({ state }).columns

    return {
      from: before.map(c => c.id),
      to: columns.map(c => c.id),
      removed: before.filter(c => !columns.some(next => next.id === c.id)).map(c => c.id),
      affectedCards: Object.keys(placements ?? {}).length,
      ...(fallback ? { fallback } : {}),
    }
  }

  return { type: event.type, target: event.cardId }
}

// The receipt the event with this id got when it was appended. An id already used
// for another card or event type is a conflict, not a retry.
function originalReceipt(
  { hydraId, state, id, seq, intent }: {
    hydraId: string
    state: HydraState
    id: string
    seq: number
    intent: Intent
  },
): Output {
  const events = readEvents({ hydraId })
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
      state: replay({ state: emptyHydra(), events: events.slice(0, index + 1) }),
      event: original,
    }),
    duplicate: 'event id already applied; nothing appended',
  }
}

// A repeated --event-id answers with the original receipt before any other check,
// so a retry of a write that already landed never reports a conflict.
export function commit(
  { hydraId, meta, intent, decide, confirmation }: {
    hydraId: string
    meta: Meta
    intent: Intent
    decide: ({ state, meta }: { state: HydraState; meta: Meta }) => Decision
    confirmation?: { token?: string; when?({ event }: { event: HydraEvent }): boolean }
  },
): Output {
  const reason = EXPLAINED.includes(intent.type) ? explained({ meta }) : ''

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      const spool = drainSpool({ writer })
      const seq = meta.id === undefined ? undefined : writer.state.eventIds[meta.id]
      let out: Output

      if (seq !== undefined) {
        out = originalReceipt({
          hydraId,
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
          const needsConfirmation = confirmation
            && (!confirmation.when || confirmation.when({ event: decision.event }))

          if (needsConfirmation) {
            const { type, cardId, data } = decision.event
            const revision = cardId === '$projects' ? writer.state.projectsRevision ?? 0
              : cardId === '$board' ? writer.state.configRevision ?? 0 : writer.state.cards[cardId]?.revision ?? 0
            const token = createHash('sha256').update(JSON.stringify({ hydraId, actor: meta.actor, type, cardId, data, revision }))
              .digest('hex')
              .slice(0, 24)

            if (confirmation.token !== token) {
              return { confirmation: 'needed', token, action: summarize({ event: decision.event }), preview: confirmationPreview({ state: writer.state, event: decision.event }), help: ['Repeat the same command with --confirm <token>; a changed target needs a new confirmation'] }
            }
          }

          writer.append({ event: decision.event })
          const { event } = decision
          const posted = meta.actor === HYDRA_ACTOR && reason && EXPLAINED.includes(event.type)
            ? postLine({ writer, hydraId, meta, cardId: event.cardId, action: actionText({ state: writer.state, hydraId, event }), reason, id: `${event.id}:line` })
            : undefined
          out = { ...receipt({ state: writer.state, event }), ...(posted ? { posted } : {}) }

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
    if (error instanceof HydraError) {
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
    ...(card.project ? { project: card.project } : {}),
    column: card.column,
    attention: card.attention.map(a => a.kind).join(' ') || 'none',
  }
}

function cardDetail({ card }: { card: Card }): Output {
  const detail: Output = {
    id: card.id,
    key: card.key,
    title: card.title,
    ...(card.project ? { project: card.project } : {}),
    ...(card.brief !== undefined ? { brief: card.brief } : {}),
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
  detail.visibility = card.hidden ? 'history' : 'hydra'
  detail.hideAfterHours = card.doneAfterHours ?? 'Hydra setting'

  if (card.settings) {
    detail.settings = card.settings
  }

  detail.permissions = card.permissions?.length ? card.permissions : 'none'
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
  hideDone({ hydraId: DEFAULT_HYDRA })
  const { dir, state, tornBytes } = loadHydra({ hydraId: DEFAULT_HYDRA })
  const cards = Object.values(state.cards).filter(card => liveTask({ card }))
  const config = hydraConfig({ state })
  const columns = Object.fromEntries(
    config.columns.map(c => [c.id, cards.filter(card => card.column === c.id).length]),
  )
  const server = await readServer({ hydraId: DEFAULT_HYDRA })
  const out: Output = { projects: projectRows({ state }), hydraId: DEFAULT_HYDRA, hydra: config.hydra.id, server: server ? `running at ${server.url}` : 'not running', columns }

  if (tornBytes > 0) {
    out.warning = 'events.jsonl has a torn tail; run `pnyx-axi repair`'
  }

  const serveHint = server ? [] : ['Run `pnyx-axi serve` to start the Hydra server']
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
    const { values, hydraId } = parse({ args, options: { ...WRITE, key: { type: 'string' }, file: { type: 'string' } }, positionals: 0 })
    const m = meta({ values })
    const key = required({ value: values.key as string | undefined, what: '--key' })
    const file = required({ value: values.file as string | undefined, what: '--file' })
    let input: unknown

    try {
      input = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8'))
    } catch (error) {
      throw new AxiError(`cannot read card JSON from ${file}: ${(error as Error).message}`, 'VALIDATION_ERROR')
    }

    return commit({ hydraId, meta: m, intent: { type: 'card.pushed', card: key }, decide: ({ state }) => decidePush({ state, key, input, meta: m }) })
  },
})

function taskCommand({ args }: { args: string[] }): Output | Promise<Output> {
  const { values, positionals, hydraId } = parse({
    args,
    options: {
      ...WRITE,
      title: { type: 'string' },
      project: { type: 'string' },
      brief: { type: 'string' },
      key: { type: 'string' },
      folder: { type: 'string' },
      session: { type: 'string' },
      'replace-session': { type: 'string' },
      parent: { type: 'string' },
      column: { type: 'string' },
      note: { type: 'string' },
      limit: { type: 'string' },
      before: { type: 'string' },
      full: { type: 'boolean' },
      harness: { type: 'string' },
      prompt: { type: 'string' },
      'paseo-url': { type: 'string' },
      check: { type: 'boolean' },
      via: { type: 'string' },
      command: { type: 'string' },
      rule: { type: 'string' },
      'in-place': { type: 'boolean' },
      safe: { type: 'boolean' },
      discard: { type: 'boolean' },
    },
    positionals: 4,
  })
  const action = positionals[0]
  const m = meta({ values })
  const url = values['paseo-url'] as string | undefined

  if (action === 'reminders') {
    const reminders = waitingReminders({ state: loadHydra({ hydraId }).state })

    return { hydraId, count: reminders.length, reminders: reminders.length ? reminders : 'none: no waiting reminders' }
  }

  if (action === 'remind') {
    const ref = required({ value: positionals[1], what: 'task id' })
    const when = required({ value: positionals[2], what: 'reminder time or clear' })

    return commit({
      hydraId,
      meta: m,
      intent: { type: 'task.reminder', card: ref },
      decide: ({ state }) => {
        const task = findCard({ state, ref })

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({ message: 'Choose a task for the reminder', code: 'VALIDATION_ERROR' })
        }

        const after = when === 'clear' ? null : reminderTime({ when, now: m.at })

        return after === (task.reminder?.at ?? null) && !task.reminder?.dueAt ? { skipped: 'unchanged' }
          : hydraEvent({ state, meta: m, cardId: task.id, change: { type: 'task.reminder', data: { before: task.reminder?.at ?? null, after } } })
      },
    })
  }

  if (action === 'permission') {
    const reason = explained({ meta: m })
    const choice = positionals[3]

    if (choice !== 'allow' && choice !== 'deny') {
      throw new HydraError({ message: 'Use task permission <task> <request> allow|deny', code: 'VALIDATION_ERROR' })
    }

    return askHost({
      hydraId,
      body: {
        action: 'permission',
        task: required({ value: positionals[1], what: 'task id' }),
        request: required({ value: positionals[2], what: 'request id' }),
        choice,
        actor: m.actor,
        ...(reason ? { reason } : {}),
        ...(m.details ? { details: m.details } : {}),
      },
    })
  }

  if (action === 'paseo') {
    return paseoStatus({ url })
  }

  if (action === 'continue' && values.check) {
    return askHost({ hydraId, body: { action: 'continue', task: required({ value: positionals[1], what: 'task id' }), check: true, id: m.id ?? randomUUID(), actor: m.actor } })
  }

  if (action === 'start' || action === 'continue') {
    const reason = explained({ meta: m })
    const ref = required({ value: positionals[1], what: 'task id' })
    const started = action === 'continue' ? askHost({ hydraId, body: { action: 'continue', task: ref, id: m.id ?? randomUUID(), actor: m.actor, ...(m.reason ? { reason: m.reason } : {}) } }) : startTask({
      hydraId,
      task: ref,
      replacement: values['replace-session'] as string | undefined,
      commandName: values.command as string | undefined,
      via: values.via as string | undefined,
      rule: values.rule as string | undefined,
      harness: values.harness as string | undefined,
      prompt: values.prompt as string | undefined,
      folder: values.folder as string | undefined,
      inPlace: Boolean(values['in-place']),
      url,
      meta: m,
    })

    if (m.actor !== HYDRA_ACTOR) {
      return started
    }

    // The worker is already started, so a failed post must not turn into an error Hydra retries.
    return started.then(out => {
      if (out.sent === 'failed') {
        return out
      }

      try {
        return {
          ...out,
          posted: withWriter({
            hydraId,
            fn: ({ writer }) => {
              const card = findCard({ state: writer.state, ref })
              const action = `${positionals[0] === 'continue' ? 'Continued the agent in Pnyx on' : out.via === 'firstmate' ? 'Asked Firstmate for a worker on' : 'Started a worker on'} ${card.title}`

              return postLine({ writer, hydraId, meta: m, cardId: card.id, action, reason, ...(m.id ? { id: `${m.id}:line` } : {}) })
            },
          }),
        }
      } catch (error) {
        return { ...out, posted: `none: ${(error as Error).message}` }
      }
    })
  }

  if (action === 'copy') {
    return copyCommand({ hydraId, ref: required({ value: positionals[1], what: 'task id' }), action: positionals[2], values, meta: m })
  }

  if (action === 'sessions') {
    const sessions = Object.values(loadHydra({ hydraId }).state.sessions ?? {}).map(s => ({
      id: s.id, provider: s.agent.provider, task: s.taskId ?? 'none', interactive: interactive({ session: s }),
    }))

    return { sessions: sessions.length ? sessions : 'none: no sessions recorded' }
  }

  if (action === 'create') {
    const title = required({ value: values.title as string | undefined, what: '--title' }).trim()
    required({ value: title, what: '--title' })
    const key = values.key as string | undefined ?? `task:${m.id ?? randomUUID()}`

    if (key.startsWith('$')) {
      throw new HydraError({ message: 'task keys beginning with $ are reserved', code: 'VALIDATION_ERROR' })
    }

    const folder = canonical({ path: values.folder })
    const brief = taskBrief({ value: values.brief })

    return commit({
      hydraId,
      meta: m,
      intent: { type: 'task.created', card: key },
      decide: ({ state }) => {
        if (state.keys[key]) {
          throw new HydraError({ message: `task key already exists: ${key}`, code: 'CONFLICT' })
        }

        const project = values.project
          ? taskProject({ state, ref: String(values.project) }) : undefined
        const parent = values.parent ? findCard({ state, ref: String(values.parent) }) : undefined

        if (parent?.parentId || parent?.automaticTask || parent?.id === HYDRA_CARD) {
          throw new HydraError({ message: 'subtasks have one level under a task', code: 'VALIDATION_ERROR' })
        }

        const columns = hydraConfig({ state, id: hydraId }).columns
        const selected = values.column
          ? columns.find(c => c.id === values.column || c.title === values.column
            || c.role === values.column) : undefined

        if (values.column && !selected) {
          throw new HydraError({ message: 'unknown Hydra column', code: 'VALIDATION_ERROR' })
        }

        const cardId = `task-${randomUUID()}`

        return hydraEvent({ state, meta: m, cardId, change: { type: 'task.created', data: { key, title, ...(project ? { project } : {}), ...(brief !== undefined ? { brief } : {}), ...(folder ? { folder } : {}), ...(parent ? { parentId: parent.id } : {}), ...(selected ? { column: selected.id } : {}) } } })
      },
    })
  }

  if (action === 'list') {
    hideDone({ hydraId })
    const state = loadHydra({ hydraId }).state

    const tasks = Object.values(state.cards).filter(c => liveTask({ card: c }))
      .map(c => ({ ...cardRow({ card: c }), parent: c.parentId ?? '', status: c.status?.state ?? 'paused', worker: c.sessionIds?.[0] ?? '' }))

    return tasks.length
      ? { hydraId, tasks, help: [`Run \`pnyx-axi task show <id> --hydra ${hydraId}\` for one task`] }
      : { hydraId, tasks: 'none: no tasks on this Hydra', help: [`Run \`pnyx-axi task create --title <title> --hydra ${hydraId}\` to add one`] }
  }

  if (action === 'history') {
    return taskHistory({ hydraId, ref: required({ value: positionals[1], what: 'task id' }), before: integer({ value: values.before, flag: '--before' }), limit: integer({ value: values.limit, flag: '--limit' }) ?? HISTORY_LIMIT, full: Boolean(values.full) })
  }

  if (action === 'show') {
    const state = loadHydra({ hydraId }).state
    const task = findCard({ state, ref: required({ value: positionals[1], what: 'task id' }) })

    if (values.full) {
      return {
        task,
        worker: task.sessionIds?.[0] ? state.sessions?.[task.sessionIds[0]] : undefined,
      }
    }

    return {
      task: { ...cardRow({ card: task }), key: task.key, ...(task.copy ? { copy: `${task.copy.path} (${task.copy.state}${task.copy.reason ? `: ${task.copy.reason}` : ''})` } : {}), brief: task.brief ?? 'none', parent: task.parentId ?? 'none', status: task.status ? `${task.status.state}${task.status.note ? `: ${task.status.note}` : ''}` : 'none: no declaration yet', worker: task.sessionIds?.[0] ?? 'none', declarations: task.statusLog?.length ?? 0, firstmate: task.mirror ? 'mirrored' : 'none' },
      help: [`Run \`pnyx-axi task show ${task.id} --full --hydra ${hydraId}\` for the full record, or \`pnyx-axi task history ${task.id} --hydra ${hydraId}\` for its events`],
    }
  }

  if (action === 'chat') {
    const state = loadHydra({ hydraId }).state
    const task = findCard({ state, ref: required({ value: positionals[1], what: 'task id' }) })
    const session = values.session ? findSession({ state, ref: String(values.session) }) : undefined

    if (session && !taskSessions({ hydraId, ids: new Set([task.id]) }).has(session.id)) {
      throw new HydraError({ message: 'this session has no recorded membership on the task', code: 'NOT_FOUND' })
    }

    const card = session ? { ...task, agent: session.agent, sessionIds: [session.id] } : task

    return {
      thread: readThread({
        hydraId, state, card, homes: [], before: values.before as string | undefined,
      }),
    }
  }

  if (action === 'project') {
    const ref = required({ value: positionals[1], what: 'task id' })
    const project = required({ value: values.project as string | undefined, what: '--project <name|path>' })

    return commit({
      hydraId,
      meta: m,
      intent: { type: 'task.project', card: ref },
      decide: ({ state }) => {
        const task = findCard({ state, ref })
        const after = findProject({ state, ref: project, attached: true }).path

        return task.project === after ? { skipped: 'unchanged' }
          : hydraEvent({ state, meta: m, cardId: task.id, change: { type: 'task.project', data: { before: task.project ?? null, after } } })
      },
    })
  }

  if (action === 'status') {
    const ref = required({ value: positionals[1], what: 'task id' })

    return commit({ hydraId, meta: m, intent: { type: 'task.declared', card: ref }, decide: ({ state }) => declareTask({ state, ref, status: required({ value: positionals[2], what: 'status' }), note: String(values.note ?? ''), meta: m }) })
  }

  if (action === 'hide-after') {
    const ref = required({ value: positionals[1], what: 'task id' })
    const raw = required({ value: positionals[2], what: 'hours or default' }).trim()
    const after = raw === 'default' ? null : Number(raw)

    if (after !== null
      && (!raw || !Number.isFinite(after) || after < 0 || after > MAX_DONE_HOURS)) {
      throw new HydraError({ message: `use hours from 0 to ${MAX_DONE_HOURS}, or default (0 keeps the card visible)`, code: 'VALIDATION_ERROR' })
    }

    return commit({
      hydraId,
      meta: m,
      intent: { type: 'task.retention', card: ref },
      decide: ({ state }) => {
        const task = findCard({ state, ref })

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({ message: 'choose a task', code: 'VALIDATION_ERROR' })
        }

        const before = task.doneAfterHours ?? null

        return before === after && !task.keepDone ? { skipped: 'unchanged' }
          : hydraEvent({ state, meta: m, cardId: task.id, change: { type: 'task.retention', data: { before, after } } })
      },
    })
  }

  if (action === 'brief' || action === 'hide' || action === 'unhide') {
    const ref = required({ value: positionals[1], what: 'task id' })

    return commit({
      hydraId,
      meta: m,
      intent: { type: action === 'brief' ? 'task.brief' : 'task.visibility', card: ref },
      decide: ({ state }) => {
        const task = findCard({ state, ref })

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({ message: 'choose a task', code: 'VALIDATION_ERROR' })
        }

        if (action === 'brief') {
          const after = taskBrief({ value: values.brief })

          if (after === undefined) {
            throw new HydraError({ message: 'pass --brief <text> (empty text clears it)', code: 'VALIDATION_ERROR' })
          }

          return after === (task.brief ?? '') ? { skipped: 'unchanged' } : hydraEvent({ state, meta: m, cardId: task.id, change: { type: 'task.brief', data: { before: task.brief ?? '', after } } })
        }

        const after = action === 'hide'

        return Boolean(task.hidden) === after ? { skipped: 'unchanged' } : hydraEvent({ state, meta: m, cardId: task.id, change: { type: 'task.visibility', data: { before: Boolean(task.hidden), after } } })
      },
    })
  }

  if (action === 'rename') {
    if (values.title === undefined && values.project === undefined) {
      throw new HydraError({ message: 'pass --title or --project (empty text clears the label)', code: 'VALIDATION_ERROR' })
    }

    const ref = required({ value: positionals[1], what: 'task id' })

    return commit({ hydraId, meta: m, intent: { type: 'card.pushed', card: ref }, decide: ({ state }) => decidePush({ state, key: findCard({ state, ref }).key, input: { ...(values.title !== undefined ? { title: required({ value: values.title as string, what: '--title' }) } : {}), ...(values.project !== undefined ? { project: values.project } : {}) }, meta: m }) })
  }

  if (action !== 'attach' && action !== 'detach') {
    throw new AxiError('Use task create, list, show, status, history, rename, start, copy, permission, paseo, sessions, attach or detach', 'VALIDATION_ERROR')
  }

  const ref = required({ value: positionals[1], what: 'task id' })

  const result = commit({
    hydraId,
    meta: m,
    intent: { type: 'task.session', card: ref },
    decide: ({ state, meta: current }) => {
      if (!liveTask({ card: findCard({ state, ref }) })) {
        throw new HydraError({ message: 'choose an explicit task; use hydra set to configure Hydra', code: 'VALIDATION_ERROR' })
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

  if (action === 'attach' && typeof result.event === 'object' && result.event !== null && 'id' in result.event) {
    const eventId = result.event.id
    const attachment = readEvents({ hydraId }).find(e => e.id === eventId)

    if (attachment?.type === 'task.session' && attachment.data.brief) {
      const home = loadHydra({ hydraId }).state.config?.hydra.home

      return sendReply({ hydraId, request: { card: attachment.cardId, text: attachment.data.brief, expectedSession: attachment.data.session, homes: home ? [home] : [], actor: m.actor, id: `brief:${attachment.id}` } }).then(brief => ({ ...result, brief }), (error: unknown) => ({ ...result, brief: { state: 'failed', detail: (error as Error).message }, help: ['The attachment was recorded; inspect the task before retrying its brief with the same --event-id'] }))
    }
  }

  return result
}

function taskBrief({ value }: { value: unknown }): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.length > 24000) {
    throw new HydraError({ message: 'a brief must be text of up to 24000 characters', code: 'VALIDATION_ERROR' })
  }

  return value
}

const task = guard({ handler: ({ args }) => taskCommand({ args }) })

function sessionRef({ state, ref }: { state: HydraState; ref: string }): string {
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

function taskHistory({ hydraId, ref, before, limit, full }: {
  hydraId: string
  ref: string
  before?: number
  limit: number
  full: boolean
}): Output {
  if (limit < 1 || limit > HISTORY_MAX) {
    throw new HydraError({ message: `limit must be 1–${HISTORY_MAX}`, code: 'VALIDATION_ERROR' })
  }

  const state = loadHydra({ hydraId }).state
  const task = findCard({ state, ref })
  const ids = new Set([task.id, ...Object.values(state.cards).filter(c => c.parentId === task.id)
    .map(c => c.id)])
  const events = readEvents({ hydraId })
  const sessions = taskSessions({ hydraId, ids })
  const matches = events.filter(e => (before === undefined || e.seq < before) && (ids.has(e.cardId) || (e.type === 'task.session' && (ids.has(e.data.before ?? '') || ids.has(e.data.after ?? ''))) || (e.type === 'hydra.message' && ids.has(e.data.task ?? ''))))
    .reverse()
  const page = matches.slice(0, limit)

  const help = [
    ...(matches.length > limit ? [`Run \`pnyx-axi task history ${ref} --before ${page.at(-1)!.seq} --hydra ${hydraId}\` for older events`] : []),
    ...(full || !page.length ? [] : [`Run \`pnyx-axi task history ${ref} --full --hydra ${hydraId}\` for each event's data`]),
  ]

  return {
    hydraId,
    task: task.id,
    sessions: sessions.size ? [...sessions].map(id => ({ session: id, transcript: state.sessions?.[id]?.agent.transcriptPath ?? 'unavailable', command: `pnyx-axi task chat ${task.id} --session ${id} --hydra ${hydraId}` })) : 'none: no agent has worked on this task',
    events: page.length ? page.map(e => ({ seq: e.seq, id: e.id, at: e.at, type: e.type, card: e.cardId, actor: e.actor, summary: summarize({ event: e }), ...(full ? { data: e.data } : {}) })) : 'none: no matching events',
    ...(matches.length > limit ? { next: page.at(-1)!.seq } : {}),
    ...(help.length ? { help } : {}),
  }
}

function taskSessions({ hydraId, ids }: { hydraId: string; ids: Set<string> }): Set<string> {
  const sessions = new Set<string>()

  for (const event of readEvents({ hydraId })) {
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

function hydraConfigCommand({ args }: { args: string[] }): Output {
  const { values, positionals, hydraId } = parse({ args, options: { ...WRITE, name: { type: 'string' }, identity: { type: 'string' }, session: { type: 'string' }, firstmate: { type: 'string' }, command: { type: 'string' }, 'command-folder': { type: 'string' }, base: { type: 'string' }, 'done-after-hours': { type: 'string' } }, positionals: 2 })
  const action = positionals[0]

  if (action === 'homes') {
    return firstmateHomes({ base: values.base as string | undefined })
  }

  if (action === 'list') {
    const hydras = hydraIds()

    if (!hydras.length) {
      return { hydras: 'none: no Hydras yet', help: ['Run `pnyx-axi hydra create <id>` to add one'] }
    }

    return {
      hydras: hydras.map(id => {
        hideDone({ hydraId: id })
        const state = loadHydra({ hydraId: id }).state
        const config = hydraConfig({ state, id })

        const tasks = Object.values(state.cards).filter(c => liveTask({ card: c })).length

        return { id, name: config.name, hydra: config.hydra.id, kind: config.hydra.kind, tasks }
      }),
      help: ['Run `pnyx-axi hydra show --hydra <id>` for its columns and Hydra'],
    }
  }

  const id = action !== 'create' ? hydraId
    : positionals[1] ?? (values.firstmate ? homeHydraId({ home: String(values.firstmate) }) : required({ value: undefined, what: 'Hydra id' }))
  hydraDir({ hydraId: id })

  if (action === 'show') {
    const state = loadHydra({ hydraId: id }).state

    return {
      hydra: hydraConfig({ state, id }),
      projects: projectRows({ state }),
      revision: state.configRevision ?? 0,
    }
  }

  if (action !== 'create' && action !== 'set') {
    throw new HydraError({ message: 'Use hydra create <id>, list, homes, show or set', code: 'VALIDATION_ERROR' })
  }

  const m = meta({ values })

  return commit({
    hydraId: id,
    meta: m,
    intent: { type: 'board.configured', card: '$board' },
    decide: ({ state }) => {
      if (action === 'create' && state.configured) {
        throw new HydraError({ message: `Hydra already exists: ${id}`, code: 'CONFLICT' })
      }

      const current = hydraConfig({ state, id })

      if (action === 'create' && !state.config && !Object.keys(state.cards).length) {
        current.columns = current.columns.map(c => ({ ...c, id: `custom:${randomUUID()}` }))
      }

      const identity = String(values.identity ?? current.hydra.id)
      required({ value: identity.trim(), what: '--identity' })
      const kept = identity === current.hydra.id ? current.hydra : undefined
      const home = canonical({ path: values.firstmate })

      if (values.firstmate && !home) {
        throw new HydraError({ message: '--firstmate must be an absolute home path', code: 'VALIDATION_ERROR' })
      }

      const session = values.session ? findSession({
        state,
        ref: sessionRef({ state, ref: String(values.session) }),
      }) : undefined

      if (session && session.taskId && !state.cards[session.taskId]?.automaticTask) {
        throw new HydraError({ message: 'detach the task worker before making it Hydra', code: 'CONFLICT' })
      }

      const hydra: HydraIdentity = { name: 'Hydra', kind: 'agent', ...kept, id: identity, ...(home ? { kind: 'firstmate', home } : {}), ...(session ? { session: session.id } : {}) }

      const command = values.command === undefined ? current.command : String(values.command).trim()
      const data: HydraConfig = { ...current, id, name: String(values.name ?? current.name), hydra }

      if (values['done-after-hours'] !== undefined) {
        const raw = String(values['done-after-hours']).trim()
        const hours = Number(raw)

        if (!raw || !Number.isFinite(hours) || hours < 0 || hours > MAX_DONE_HOURS) {
          throw new HydraError({ message: `--done-after-hours must be a number from 0 to ${MAX_DONE_HOURS} (0 keeps Done cards visible)`, code: 'VALIDATION_ERROR' })
        }

        data.doneAfterHours = hours
      }

      delete data.command

      if (command) {
        data.command = command
      }

      const owns = values['command-folder']

      if (owns !== undefined && owns !== 'own' && owns !== 'copy') {
        throw new HydraError({ message: '--command-folder must be own or copy', code: 'VALIDATION_ERROR' })
      }

      if (owns === 'own') {
        data.commandOwnsFolder = true
      } else if (owns === 'copy') {
        delete data.commandOwnsFolder
      }

      return hydraEvent({ state, meta: m, cardId: '$board', change: { type: 'board.configured', data } })
    },
  })
}

function homeHydraId({ home }: { home: string }): string {
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
  let hydras: { id: string; home?: string }[] = []

  try {
    hydras = hydraIds().map(id => ({
      id,
      home: loadHydra({ hydraId: id }).state.config?.hydra.home,
    }))
  } catch { /* An unreadable Hydra links no home. */ }

  if (!homes.length) {
    return { base: root, homes: 'none: no Firstmate homes found', help: ['Pass --base <folder holding the homes>'] }
  }

  const rows = homes.map(home => {
    const real = canonical({ path: home }) ?? home
    const hydraId = hydras.find(b => b.home === real)?.id

    return { home: real, hydraId: hydraId ?? 'none', ...(hydraId ? {} : { create: `pnyx-axi hydra create --firstmate ${real}` }) }
  })

  return { base: root, homes: rows, help: ['Each home gets its own Hydra; run the create command of a home without one'] }
}

function columnCommand({ args }: { args: string[] }): Output {
  const { values, positionals, hydraId } = parse({ args, options: { ...WRITE, title: { type: 'string' }, description: { type: 'string' }, width: { type: 'string' }, id: { type: 'string' }, to: { type: 'string' }, before: { type: 'string' } }, positionals: 2 })
  const action = positionals[0]

  if (action === 'list') {
    const state = loadHydra({ hydraId }).state

    return {
      columns: hydraConfig({ state, id: hydraId }).columns,
      revision: state.configRevision ?? 0,
    }
  }

  const m = meta({ values })

  if (action === 'resize') {
    const ref = required({ value: positionals[1], what: 'column id' })
    const width = integer({ value: values.width, flag: '--width' })

    if (width === undefined) {
      throw new HydraError({ message: 'pass --width <pixels>', code: 'VALIDATION_ERROR' })
    }

    return commit({
      hydraId,
      meta: m,
      intent: { type: 'board.view', card: '$board' },
      decide: ({ state }) => {
        if (!hydraConfig({ state, id: hydraId }).columns.some(c => c.id === ref)) {
          throw new HydraError({ message: `column not found: ${ref}`, code: 'NOT_FOUND' })
        }

        return decideView({ state, patch: { columnWidths: { [ref]: width } }, meta: m })
      },
    })
  }

  return commit({
    hydraId,
    meta: m,
    ...(m.actor !== 'web' && (action === 'delete' || action === 'reorder') ? { confirmation: { token: values.confirm as string | undefined } } : {}),
    intent: { type: 'board.columns', card: '$board' },
    decide: ({ state }) => {
      const before = structuredClone(hydraConfig({ state, id: hydraId }).columns)
      let columns = structuredClone(before)
      const ref = positionals[1]
      const selected = columns.find(c => c.id === ref || c.role === ref)

      if (action !== 'create' && !selected) {
        throw new HydraError({ message: `column not found: ${ref}`, code: 'NOT_FOUND' })
      }

      if (action === 'delete' && lockedColumn({ state, id: selected!.id })) {
        throw new HydraError({ message: LOCKED_DELETE, code: 'VALIDATION_ERROR' })
      }

      let fallback: Column | undefined

      if (action === 'create') {
        const id = String(values.id ?? `custom:${randomUUID()}`)

        if (!/^custom:[a-z0-9-]{1,60}$/.test(id)) {
          throw new HydraError({ message: 'new column ids use custom:<letters-digits-dashes>', code: 'VALIDATION_ERROR' })
        }

        columns.push({ id: id as Column, title: required({ value: values.title as string, what: '--title' }), description: String(values.description ?? '') })
      } else if (action === 'rename') {
        selected!.title = required({ value: values.title as string, what: '--title' })
      } else if (action === 'describe') {
        if (typeof values.description !== 'string') {
          throw new HydraError({ message: 'pass --description <text> (empty text clears it)', code: 'VALIDATION_ERROR' })
        }

        selected!.description = values.description
      } else if (action === 'delete') {
        columns = columns.filter(c => c.id !== selected!.id)
        fallback = values.to
          ? columns.find(c => c.id === values.to || c.role === values.to)?.id : columns[0]?.id

        if (values.to && !fallback) {
          throw new HydraError({ message: 'fallback column not found', code: 'VALIDATION_ERROR' })
        }
      } else if (action === 'reorder') {
        columns = columns.filter(c => c.id !== selected!.id)
        const index = values.before
          ? columns.findIndex(c => c.id === values.before || c.role === values.before)
          : columns.length

        if (index < 0) {
          throw new HydraError({ message: '--before column not found', code: 'VALIDATION_ERROR' })
        }

        columns.splice(index, 0, selected!)

        if (columns.every((c, i) => c.id === before[i]!.id)) {
          return { skipped: 'unchanged' }
        }
      } else {
        throw new HydraError({ message: 'Use column list, create, rename, describe, resize, delete or reorder', code: 'VALIDATION_ERROR' })
      }

      validateColumns({ columns })

      if (isDeepStrictEqual(columns, before)) {
        return { skipped: 'unchanged' }
      }

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
  if (['create', 'list', 'homes', 'show', 'set'].includes(args[0] ?? '')) {
    return hydraConfigCommand({ args })
  }

  const { values, positionals, hydraId } = parse({ args, options: { ...WRITE, task: { type: 'string' }, action: { type: 'string' }, key: { type: 'string' }, width: { type: 'string' }, text: { type: 'string' }, after: { type: 'string' }, limit: { type: 'string' }, full: { type: 'boolean' }, via: { type: 'string' }, rule: { type: 'string' }, harness: { type: 'string' }, prompt: { type: 'string' }, folder: { type: 'string' }, home: { type: 'string' }, 'paseo-url': { type: 'string' } }, positionals: 2 })

  if (positionals[0] === 'resize') {
    const width = integer({ value: values.width, flag: '--width' })

    if (width === undefined) {
      throw new HydraError({ message: 'pass --width <pixels>', code: 'VALIDATION_ERROR' })
    }

    const m = meta({ values })

    return commit({ hydraId, meta: m, intent: { type: 'board.view', card: '$board' }, decide: ({ state }) => decideView({ state, patch: { hydraWidth: width }, meta: m }) })
  }

  if (positionals[0] === 'memory') {
    const action = positionals[1] ?? 'list'

    if (action === 'list') {
      const entries = Object.entries(loadHydra({ hydraId }).state.hydraMemory ?? {})
        .map(([key, entry]) => ({ key, ...entry }))

      return { memory: entries.length ? entries : 'none: no Hydra memory yet' }
    }

    const key = required({ value: values.key as string | undefined, what: '--key' })

    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key) || !['set', 'forget'].includes(action)) {
      throw new HydraError({ message: 'use hydra memory list|set|forget; keys use lowercase letters, digits and dashes', code: 'VALIDATION_ERROR' })
    }

    const after = action === 'forget' ? null : required({ value: values.text as string | undefined, what: '--text' }).trim()

    if (after !== null && (!after || after.length > 4000)) {
      throw new HydraError({ message: 'memory text must have 1–4000 characters', code: 'VALIDATION_ERROR' })
    }

    const m = meta({ values })

    return commit({
      hydraId,
      meta: m,
      intent: { type: 'hydra.memory', card: '$board' },
      decide: ({ state }) => {
        const before = state.hydraMemory?.[key]?.text ?? null

        return before === after ? { skipped: 'unchanged' } : hydraEvent({ state, meta: m, cardId: '$board', change: { type: 'hydra.memory', data: { key, before, after } } })
      },
    })
  }

  if (positionals[0] === 'start') {
    return startHydra({
      hydraId,
      via: values.via as string | undefined,
      rule: values.rule as string | undefined,
      harness: values.harness as string | undefined,
      prompt: values.prompt as string | undefined,
      folder: values.folder as string | undefined,
      home: values.home as string | undefined,
      url: values['paseo-url'] as string | undefined,
      meta: meta({ values }),
    })
  }

  if (positionals[0] === 'messages') {
    const state = loadHydra({ hydraId }).state
    const after = integer({ value: values.after, flag: '--after' }) ?? 0
    const limit = Math.min(integer({ value: values.limit, flag: '--limit' }) ?? HISTORY_LIMIT, HISTORY_MAX)

    if (limit < 1) {
      throw new HydraError({ message: '--limit must be positive', code: 'VALIDATION_ERROR' })
    }

    const events = readEvents({ hydraId }).filter((e): e is Extract<HydraEvent, { type: 'hydra.message' | 'task.reminder-due' }> => e.seq > after && (e.type === 'hydra.message' || e.type === 'task.reminder-due'))
    const page = events.slice(0, limit)

    const through = page.at(-1)?.seq ?? after

    return {
      hydra: hydraConfig({ state, id: hydraId }).hydra.id,
      messages: page.length
        ? page.map(e => {
          const data = e.type === 'task.reminder-due' ? e.data.message : e.data

          return values.full ? e : { seq: e.seq, id: e.id, at: e.at, actor: e.type === 'task.reminder-due' ? HYDRA_ACTOR : e.actor, task: data.task ?? 'none', action: data.action, text: data.text, ...(data.details ? { details: data.details } : {}), ...('context' in data && data.context ? { context: data.context } : {}) }
        })
        : `none: no messages after seq ${after}`,
      through,
      ...(events.length > limit ? { help: [`Run \`pnyx-axi hydra messages --after ${through} --hydra ${hydraId}\` for the next page`] } : { help: [`Run \`pnyx-axi hydra messages --after ${through} --hydra ${hydraId}\` later for new messages`] }),
    }
  }

  if (positionals[0] !== 'send') {
    throw new HydraError({ message: 'Use hydra send --text <message>, hydra send --task <id> [--action send|worker] or hydra messages', code: 'VALIDATION_ERROR' })
  }

  const m = meta({ values })

  const ref = values.task === undefined ? undefined : required({ value: values.task as string, what: '--task' })

  if (!ref && values.action !== undefined) {
    throw new HydraError({ message: '--action needs --task', code: 'VALIDATION_ERROR' })
  }

  return commit({
    hydraId,
    meta: m,
    intent: { type: 'hydra.message', card: ref ?? '$board' },
    decide: ({ state }) => {
      const task = ref ? findCard({ state, ref }) : undefined

      if (task && !liveTask({ card: task })) {
        throw new HydraError({ message: 'choose a task, not an unassigned session', code: 'VALIDATION_ERROR' })
      }

      const action = String(values.action ?? 'send')

      if (action !== 'send' && action !== 'worker') {
        throw new HydraError({ message: '--action must be send or worker', code: 'VALIDATION_ERROR' })
      }

      const text = task
        ? String(values.text ?? `${action === 'worker' ? 'Create a worker for' : 'Work with me on'} task ${task.id}: ${task.title}. Read its task history and current record before continuing.`)
        : required({ value: values.text as string | undefined, what: '--text' })
      const context = mentionContext({ state, text })
      const decision = hydraEvent({ state, meta: m, cardId: task?.id ?? '$board', change: { type: 'hydra.message', data: { ...(task ? { task: task.id } : {}), action, text, ...(m.details ? { details: m.details } : {}), ...(context ? { context } : {}), hydra: hydraConfig({ state, id: hydraId }).hydra.id } } })

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

function cardNotes({ hydraId, card, full }: {
  hydraId: string
  card: Card
  full: boolean
}): { notes: Output; cut: boolean } {
  const ids = new Set((card.notes ?? []).map(n => n.id))
  const events = ids.size ? readEvents({ hydraId }).filter((e): e is NotedEvent => e.type === 'card.noted' && ids.has(e.id)) : []
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
    const { values, positionals, hydraId } = parse({ args, options: { ...COMMON, full: { type: 'boolean' } }, positionals: 1 })
    const found = findCard({ state: loadHydra({ hydraId }).state, ref: required({ value: positionals[0], what: 'card id' }) })
    const { notes, cut } = cardNotes({ hydraId, card: found, full: Boolean(values.full) })
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
// ponytail: reads every linked pull request on each run; skip merged ones already noted if hydras grow.
const harvest = guard({
  handler: ({ args }) => {
    const { values, hydraId } = parse({ args, options: { ...COMMON, card: { type: 'string' } }, positionals: 0 })
    const { state } = loadHydra({ hydraId })
    const cards = values.card ? [findCard({
      state,
      ref: values.card as string,
    })] : Object.values(state.cards)
    // Read before taking the writer lock: gh-axi can be slow and must not block other writers.
    const prs = cards.flatMap(c => c.links.filter(l => l.kind === 'github_pr').map(l => ({ card: c.id, url: l.url, note: pullRequestNote({ url: l.url }) })))

    return withWriter({
      hydraId,
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
    const { values, positionals, hydraId } = parse({ args, options: { ...WRITE, before: { type: 'string' } }, positionals: 2 })
    const m = meta({ values })
    const ref = required({ value: positionals[0], what: 'card id' })
    const target = column({ value: required({ value: positionals[1], what: 'column' }) })
    const before = values.before as string | undefined

    return commit({ hydraId, meta: m, intent: { type: 'card.moved', card: ref }, ...(m.actor !== 'web' ? { confirmation: { token: values.confirm as string | undefined } } : {}), decide: ({ state }) => decideMove({ state, ref, column: hydraConfig({ state }).columns.find(c => c.id === target || c.role === target)?.id ?? target, before, meta: m }) })
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
    const { values, positionals, hydraId } = parse({ args, options, positionals: 1 })
    const m = meta({ values })
    const ref = required({ value: positionals[0], what: 'card id' })
    const url = required({ value: values.url as string | undefined, what: '--url' })
    const s = ({ name }: { name: string }) => values[name] as string | undefined
    const parsed = values.remove
      ? null
      : parseLink({ input: { url, kind: s({ name: 'kind' }), number: s({ name: 'number' }), title: s({ name: 'title' }), state: s({ name: 'state' }), checkedAt: s({ name: 'state' }) && new Date().toISOString() } })

    return commit({ hydraId, meta: m, intent: { type: 'card.linked', card: ref }, decide: ({ state }) => decideLink({ state, ref, url, link: parsed, meta: m }) })
  },
})

const outcome = guard({
  handler: ({ args }) => {
    const { values, positionals, hydraId } = parse({ args, options: { ...WRITE, note: { type: 'string' }, clear: { type: 'boolean' } }, positionals: 2 })
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

    return commit({ hydraId, meta: m, intent: { type: 'card.outcome', card: ref }, decide: ({ state: s }) => decideOutcome({ state: s, ref, outcome: result, meta: m }) })
  },
})

export function summarize({ event }: { event: HydraEvent }): string {
  const text = summary({ event })

  return event.reason ? `${text} (why: ${event.reason})` : text
}

function summary({ event }: { event: HydraEvent }): string {
  const undo = event.undoes ? `undo ${event.undoes}: ` : ''

  switch (event.type) {
    case 'chat.message': return `${event.data.role}: ${event.data.text}`
    case 'board.configured': return `Hydra ${event.data.name}; Hydra ${event.data.hydra.id}`
    case 'board.columns': return `Columns: ${event.data.columns.map(c => c.title).join(', ')}`
    case 'hydra.project': return `${event.data.before && event.data.before.detached === event.data.after.detached ? 'Updated' : event.data.after.detached ? 'Detached' : 'Attached'} project ${event.data.after.name}: ${event.data.after.path}${event.data.sharedWith.length ? `; shared with Hydra ${event.data.sharedWith.map(h => h.name).join(', ')}` : ''}`
    case 'task.project': return `Task project: ${event.data.after ?? 'none'}`
    case 'task.copy': return `Task copy ${event.data.after.state}: ${event.data.after.path}${event.data.after.reason ? ` (${event.data.after.reason})` : ''}`
    case 'task.created': return `Created ${event.data.parentId ? 'subtask' : 'task'}: ${event.data.title}`
    case 'task.permission': return `${event.data.tool} permission ${event.data.id}: ${event.data.status}`
    case 'task.reminder': return event.data.after ? `Reminder set for ${event.data.after}` : 'Reminder cleared'
    case 'task.reminder-due': return event.data.message.text
    case 'task.brief': return 'Task brief updated'
    case 'task.retention': return event.data.after === null ? 'Using the Hydra hide time' : event.data.after === 0 ? 'Keeping the Done card visible' : `Done card hidden after ${event.data.after} hours`
    case 'task.visibility': return event.data.after ? 'Task hidden from Hydra' : 'Task returned to Hydra'
    case 'hydra.memory': return `${event.data.after === null ? 'Forgot' : 'Saved'} Hydra memory: ${event.data.key}`
    case 'task.declared': return `${event.data.state}: ${event.data.note}`
    case 'task.launched': return `Started through ${event.data.via} in ${event.data.folder ?? 'unknown folder'}`
    case 'task.mirrored': return `Mirrored Firstmate task ${event.data.task}`
    case 'hydra.message': return `${event.actor === HYDRA_ACTOR ? 'Hydra' : event.data.action === 'worker' ? 'Create a worker' : 'Send to Hydra'}: ${event.data.text}${event.data.details ? ` (${event.data.details})` : ''}`
    case 'board.agents': return `Legacy agents: ${Object.keys(event.data.agents).join(', ') || 'none'}`
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
    const { values, hydraId } = parse({ args, options, positionals: 0 })
    const limit = Math.min(integer({ value: values.limit, flag: '--limit' }) ?? HISTORY_LIMIT, HISTORY_MAX)
    const before = integer({ value: values.before, flag: '--before' })
    const kind = values.kind as string | undefined
    const type = kind && (kind.includes('.') ? kind : `card.${kind}`)

    if (type && !(EVENT_TYPES as readonly string[]).includes(type)) {
      throw new AxiError(`unknown kind: ${kind}`, 'VALIDATION_ERROR', ['Use one of pushed, moved, linked, outcome, replied, noted'])
    }

    const { state } = loadHydra({ hydraId })
    const cardId = values.card ? findCard({ state, ref: values.card as string }).id : undefined
    const workspace = values.workspace as string | undefined
    // An outcome keeps the workspace it was recorded under; other events use the card's current one.
    const inWorkspace = ({ e }: { e: HydraEvent }) =>
      (e.type === 'card.outcome' ? e.data.card.workspace : state.cards[e.cardId]?.workspace) === workspace

    const matches = readEvents({ hydraId })
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
      const flags = ['card', 'kind', 'workspace', 'limit', 'hydra'].flatMap(f => (values[f] ? [`--${f}`, String(values[f])] : []))
      out.help = [`Run \`pnyx-axi history ${[...flags, '--before', String(page.at(-1)!.seq)].join(' ')}\` for older events`]
    }

    return out
  },
})

const undo = guard({
  handler: ({ args }) => {
    const { values, positionals, hydraId } = parse({ args, options: WRITE, positionals: 1 })
    const m = meta({ values })
    const id = required({ value: positionals[0], what: 'event id' })
    const target = readEvents({ hydraId }).find(e => e.id === id)

    if (!target) {
      throw new AxiError(`event not found: ${id}`, 'NOT_FOUND', ['Run `pnyx-axi history` to find event ids'])
    }

    return commit(
      {
        hydraId,
        meta: m,
        intent: { type: target.type, card: target.cardId },
        decide: ({ state, meta: current }) => decideUndo({ state, target, meta: current }),
      },
    )
  },
})

const repair = guard({
  handler: ({ args }) => {
    const { hydraId } = parse({ args, options: COMMON, positionals: 0 })
    const result = repairHydra({ hydraId })

    return {
      repair: result.tornBytes > 0 ? `set aside ${result.tornBytes} torn bytes` : 'none: log ends cleanly',
      ...(result.preserved ? { preserved: result.preserved } : {}),
      snapshot: `rebuilt through seq ${result.seq}`,
    }
  },
})

const setup = guard({
  handler: ({ args }) => {
    const options: Options = { ...WRITE, harness: { type: 'string' }, remove: { type: 'boolean' }, preview: { type: 'boolean' }, home: { type: 'string' }, port: { type: 'string' } }
    const { values, positionals, hydraId } = parse({ args, options, positionals: 1 })

    if (positionals[0] === 'skills') {
      return setupSkills({ remove: !!values.remove, preview: !!values.preview })
    }

    if (positionals[0] === 'service') {
      if (values.home !== undefined || args.some(a => a === '--hydra' || a.startsWith('--hydra='))) {
        throw new AxiError('setup service runs every Hydra; it takes no --hydra or --home', 'VALIDATION_ERROR', ['Run `pnyx-axi setup hydra --home <firstmate home> --hydra <id>` to link a Firstmate home to its Hydra'])
      }

      return setupService({ port: integer({ value: values.port, flag: '--port' }), remove: !!values.remove, preview: !!values.preview })
    }

    if (positionals[0] === 'hydra') {
      return setupHydra({ hydraId, home: required({ value: values.home as string | undefined, what: '--home' }), meta: meta({ values }) })
    }

    if (positionals[0] !== 'hooks') {
      throw new AxiError(`unknown setup target: ${positionals[0] ?? '(none)'}`, 'VALIDATION_ERROR', ['Run `pnyx-axi setup skills`, `pnyx-axi setup hooks` or `pnyx-axi setup hydra --home <firstmate home>`'])
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

    help.push(remove ? 'Run `pnyx-axi setup hooks` to install them again' : 'New sessions appear on the Hydra; run `pnyx-axi` to see it')
    out.help = help

    return out
  },
})

const view = guard({
  handler: ({ args }) => {
    const [sub, ...rest] = args
    const { values, hydraId } = parse({ args: rest, options: { ...WRITE, json: { type: 'string' } }, positionals: 0 })

    if (sub === 'show') {
      const { state } = loadHydra({ hydraId })

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

    return commit({ hydraId, meta: m, intent: { type: 'board.view', card: '$board' }, decide: ({ state: s }) => decideView({ state: s, patch, meta: m }) })
  },
})

const layout = guard({
  handler: ({ args }) => {
    const { values, positionals, hydraId } = parse({ args, options: WRITE, positionals: 1 })

    if (positionals[0] === 'show') {
      const view = viewFor({ state: loadHydra({ hydraId }).state })

      return {
        widths: { hydra: view.hydraWidth, columns: view.columnWidths },
        defaults: {
          column: DEFAULT_WIDTHS.column,
          hydra: view.defaultHydraWidth,
          columns: view.defaultColumnWidths,
        },
      }
    }

    if (positionals[0] !== 'reset') {
      throw new HydraError({ message: 'use layout show or reset', code: 'VALIDATION_ERROR' })
    }

    const m = meta({ values })

    return commit({ hydraId, meta: m, intent: { type: 'board.view', card: '$board' }, decide: ({ state }) => decideView({ state, patch: resetLayoutWidths({ view: viewFor({ state }) }), meta: m }) })
  },
})

export const commands = {
  layout,
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
description: Pnyx shows every agent and its work in Hydras
commands:
  pnyx-axi                                   Show the Hydra summary
  hydra create|list|homes|show|set            Create, list or configure Hydras
  project add|list|set|remove                   Attach, list or detach projects
  column create|rename|describe|resize|delete|reorder|list  Edit columns
  task create|list|show|rename|status|history|permission Tasks and one level of subtasks (--parent <id>)
  task start|continue <task>                  Start a worker or host an ended outside session
  hydra start|send|messages|check            Start the Hydra, queue task context in its chat, read it, or wait for changes
  rule; account list|set|remove              Heads dispatch rules and worker login folders
  task sessions                              List recorded sessions, including background runs
  task attach|detach <task> [--session <id>]  Attach an interactive session or detach it
  push --key <key> --file <card.json|->      Create or update the card with this key
  card <id|key> [--full]                     Show one card with its summary, decisions and context
  harvest [--card <id>]                      Collect summaries and decisions sources already recorded
  move <id> <column> [--before <id>]         Put a card in a column, above another card or at its end
  link <id> --url <url> [--state open]       Add, update or --remove a link
  outcome <id> done|failed|cancelled         Record the task outcome (--note, --clear)
  history [--card <id>] [--before <seq>]     Page through past events, newest first
  oracle "<words>" | status | rebuild        Full-text search over titles, links, events and transcripts
  settings [set <key> <value>]               Oracle settings: semantic search, reranker and model
  undo <event-id>                            Append the reverse of a manual edit, move, link or outcome
  view show|schema|set; layout show|reset      Inspect or save preferences; reset widths
  repair                                     Set aside a torn log tail and rebuild the snapshot
  serve [--port <n>]                         Run the one server of every Hydra until stopped
  stop                                       Stop the running server
  setup skills|hooks|service                Install global skills, reporting hooks or the macOS login service (--remove, --preview)
  setup hydra --home <firstmate home>        Make a Firstmate home Hydra and give it the pnyx-hydra skill
  integrations                               Show which integrations are ready and how to set each up
  reply <id> --text <text> [--home <path>]   Send a reply through the card's Firstmate home or its session's terminal
  agent <id> [<setting> <value>]             List or change a session's model, effort, mode or fast mode from its card
  firstmate sync|watch --home <path>         Fold a Firstmate home's tasks into the Hydra, once or on every change
flags:
  --hydra <name>     Hydra to use (default: default)
  --event-id <id>    On writes: idempotency key; a repeat returns the original receipt
  --if-revision <n>  On writes: expected card revision (0 for a new card)
  --help | --version Show command help or the installed version
`

const COMMAND_HELP: Record<string, string> = {
  hydra: `usage: pnyx-axi hydra create <id> [--name <name>] [--identity <identity>] [--session <session>] [--firstmate <home>]
pnyx-axi hydra create --firstmate <home>
pnyx-axi hydra list
pnyx-axi hydra homes [--base <folder>]
pnyx-axi hydra show|set --hydra <id> [--identity <identity>] [--session <session>] [--firstmate <home>] [--command <shell>] [--command-folder own|copy] [--done-after-hours <hours>]
Each Hydra has one orchestrator identity. Changing that identity preserves tasks, history and old messages.
--session self picks the session running in the caller's own Paseo terminal, tmux pane or Herdr pane. No process is launched. A session used as Hydra cannot also be a task worker.
hydra create --firstmate names the Hydra after the home's folder. hydra homes lists the Firstmate homes
in --base (FIRSTMATE_FACTORY_BASE, default ~/projects/agentic-engineering-workflow) and each one's Hydra.
--done-after-hours hides cards after continuous time in Done (default 24); 0 keeps them visible. Hidden cards remain in History and Oracle. task unhide brings one back until it leaves Done and returns.
--command sets the shell command task start --via command and hydra start --via command run; an empty value clears it.
--command-folder own says the command makes its own folder, so it runs in the project folder and Pnyx makes no task copy; copy (the default) runs it in the task's copy.
pnyx-axi hydra send --task <id> [--action send|worker] [--text <message>] [--details <text>]
pnyx-axi hydra send --text <message> [--details <text>]
pnyx-axi hydra resize --width <pixels>
pnyx-axi hydra memory list|set|forget [--key <key>] [--text <text>]
pnyx-axi hydra messages [--after <seq>] [--limit <n>] [--full]
pnyx-axi hydra check [--after <seq>] [--wait <seconds>]
pnyx-axi hydra start [--via paseo|command] [--rule <name>] [--harness claude|codex] [--prompt <text>] [--folder <path>] [--paseo-url <url>]
pnyx-axi hydra start --via firstmate --home <firstmate home>
hydra start starts Hydra: in Paseo (Claude Code by default) or with the configured command, its
session becomes Hydra (in Paseo on the hydra rule's agent unless --rule names another); a Firstmate home becomes Hydra as \`setup hydra\` makes it. The default
prompt points Hydra at the pnyx-hydra skill.
Messages are durable entries in Hydra’s chat; one without --task is about the Hydra, not a task. No worker is launched or native terminal typed into.
Hydra reads messages and task history through AXI. --after is an event sequence cursor.
check is Hydra's light check: it lists only what Hydra tracks (messages, task creation, briefs, visibility, declarations, open agent questions, attachments, columns, moves, links) after --after (default: now), skipping Hydra's own writes (actor hydra)
except its chat lines, which are listed but never end a wait; with --wait it blocks up to that many seconds until something else appears. It also records native task conversations
and returns a compact conversations digest of owner instructions and agent replies. Read task history --full
for complete messages. Pass the printed through as the next --after; unavailable native sources are reported for retry.
`,
  column: `usage: pnyx-axi column list
pnyx-axi column create --title <title> [--id custom:<id>]
pnyx-axi column rename <id> --title <title>
pnyx-axi column describe <id> --description <text>
pnyx-axi column resize <id> --width <pixels>
pnyx-axi column delete <id> [--to <remaining-column>]
pnyx-axi column reorder <id> [--before <id>]
All columns, including template columns, can be edited. Deletion moves cards to the fallback;
the final column cannot be deleted. Reorder and delete first return confirmation: needed and a token;
repeat the same command with --confirm <token>. Browser actions already carry the owner’s intent.
Use --if-revision for the Hydra revision (the view revision for resize).
`,
  task: `usage: pnyx-axi task hide-after <task> <hours|default> [--hydra <id>]
pnyx-axi task create --title <title> [--project <name>] [--brief <text>] [--key <key>] [--folder <path>] [--column <id>] [--parent <task>] [--reason <text>] [--details <text>]
pnyx-axi task brief <id> --brief <text> [--reason <text>] [--details <text>]
pnyx-axi task hide|unhide <id> [--reason <text>] [--details <text>]
pnyx-axi task list | show <id> [--full]
pnyx-axi task rename <id> [--title <title>] [--project <name>]
--project adds a compact project label; an empty value clears it.
pnyx-axi task status <id> working|needs_you|paused|blocked|done [--note <text>]
pnyx-axi task history <id> [--before <seq>] [--limit <n>] [--full]
pnyx-axi task chat <id> [--session <past-or-current-session>] [--before <cursor>]
pnyx-axi task permission <task> <request> allow|deny [--reason <text>]
pnyx-axi task project <task> --project <name|path>
pnyx-axi task remind <task> <when|clear>
pnyx-axi task reminders
pnyx-axi task continue <task> [--check]
pnyx-axi task start <task> [--via pnyx|paseo] [--rule <name>] [--harness claude|codex] [--prompt <text>] [--folder <path>] [--in-place] [--paseo-url <url>] [--replace-session <session>]
pnyx-axi task start <task> --via firstmate [--prompt <text>]
pnyx-axi task start <task> --via command [--command <project-command-name>] [--prompt <text>] [--harness <name>] [--folder <path>] [--in-place]
pnyx-axi task copy <task> [remove [--safe | --discard]]
Hydra (actor hydra) must pass --reason, one short why, to create, brief, hide, unhide, start and permission, as to move. Pnyx keeps it on the event,
posts "<what Hydra did>: <reason>" in Hydra’s chat with --details under it, and returns that line as posted.
pnyx-axi task paseo [--paseo-url <url>]
pnyx-axi task sessions
pnyx-axi task attach <task> --session <session-id|card-id|key|self>
pnyx-axi task detach <task>
Tasks accept one attached session. A second session cannot replace the recipient.
attach moves an interactive session to the task; an occupied destination is rejected.
detach removes the attachment without stopping the session; it stays in task sessions and History.
attach sends a saved task brief as its first task message and reports the delivery result; detach never stops a process. Writes accept --if-revision and --event-id.
task create accepts --project <name|path>; task project assigns an existing task to an attached project.
task remind sets one reminder per task; use a future ISO timestamp with a timezone, "tomorrow 9:00" (laptop time), or "in 2 hours". clear removes it. task reminders lists waiting reminders and their count. The server fires overdue reminders on startup, moves the task to Needs you, and records a line in Hydra’s chat.

task continue adopts an ended outside Claude Code or Codex session; --check only reads its current presence.
It refuses a running or unverified terminal session; the next message resumes the same session in its recorded folder.
task start runs Claude Code (Agent SDK) or Codex (app-server) in the task's folder through the Hydra's
Pnyx server (\`pnyx-axi serve\`), with your own provider settings, skills and hooks, and records its native session, folder
and settings on the task. Replies and setting changes from the Hydra or \`pnyx-axi reply\` and \`pnyx-axi agent\`
go straight to it; after a server restart the next message resumes the same session. A turn that was
running when the server stopped is marked interrupted and waits for a message. Permission prompts are
refused for now. Codex mode is its approval policy (untrusted, on-request or never); its sandbox follows
your Codex configuration. Codex applies picker changes on the next turn and queues messages during a turn.
--via paseo asks the local Paseo daemon (PNYX_PASEO_URL, default ws://127.0.0.1:6767/ws) to start a
Claude Code or Codex agent instead, then attaches it; replies and the conversation go through Paseo,
and the agent stays in Paseo too. task paseo checks the daemon. --folder also records the task's folder.
Repeating the same --event-id never starts a second agent.
--rule chooses the heads dispatch candidate list (default: default); --harness filters that list and
--prompt its opening message, which otherwise names the task and the pnyx-worker skill.
--via firstmate puts a worker request in Hydra's chat and sends it to the Hydra's Firstmate home as an inbox note.
--via command --command <name> selects the assigned project’s named command (project list); without --command it runs the configured Hydra command. It runs in the task's folder with PNYX_TASK and the rest of its context in the
environment; the session it starts attaches to the task when its hooks first report.
The default route is firstmate for a Hydra run by a Firstmate home, otherwise pnyx.
A task with an attached project starts in its own copy: a git worktree on branch pnyx/<hydra>-<task> (or the project's
copy command, see project set), made once and reused by later starts. --in-place works in the project folder itself and is
refused while a worker of another Hydra runs there; --folder names the folder outright. Firstmate Hydras make their own copies.
When the task reaches Done and its agent stops working, Pnyx removes its copy if it has no uncommitted changes and its commit
is on the default branch or its linked pull request merged; the branch stays. Copies from a project's copy command are only released. Otherwise the task keeps the copy, flagged, and Hydra gets a message.
task copy shows the copy and that check. task copy remove settles it again; --safe (Hydra) confirms a clean copy whose work
already landed or is empty; --discard removes work that never landed and needs the owner's --confirm <token>, never Hydra's.
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
  card: `usage: pnyx-axi card <id|key> [--full] [--hydra <name>]
Shows the card and its notes in three sections, summary, decisions and context, newest first:
${NOTES_SHOWN} per section with text cut at ${NOTE_CUT} characters, or every note in full with --full.
`,
  harvest: `usage: pnyx-axi harvest [--card <id>] [--hydra <name>]
Collects notes that sources already recorded, with no model and nothing asked of agents: Claude Code
compaction summaries, session titles and AskUserQuestion answers, Codex compaction summaries, and each
linked pull request's title and description through gh-axi. Sessions are also harvested whenever a
turn ends; Firstmate decisions, reports and Captain's intent arrive through \`firstmate sync\`.
Sources are only read. Each note is kept once, so running it again appends only what is new.
`,
  move: `usage: pnyx-axi move <id> <column-id> [--before <id>] [--event-id <id>] [--if-revision <n>] [--reason <text>] [--details <text>]
Puts the card in the column just above the --before card, or at the end of the column without it.
First returns confirmation: needed and a token; repeat with --confirm <token> to act.
Hydra places a card only in response to its own agent’s actions, using the descriptions from \`pnyx-axi column list\`.
Hydra's moves need --reason; Pnyx posts "Moved <task> to <column>: <reason>" in Hydra’s chat and returns it as posted. The owner's moves need none.
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
  setup: `usage: pnyx-axi setup service [--port <n>] [--remove] [--preview]
pnyx-axi setup hooks [--harness claude|codex] [--remove] [--preview]
pnyx-axi setup skills [--remove] [--preview]
pnyx-axi setup hydra --home <firstmate home> [--hydra <id>]
setup skills links pnyx-hydra and pnyx-worker from this installation into ~/.claude/skills
(or $CLAUDE_CONFIG_DIR/skills) and ~/.agents/skills. Updates to the installation apply to the links.
Existing files and unrelated links are never replaced; --remove takes out only this install's links.
Adds Pnyx's reporting hook to the user-level Claude Code settings.json or Codex hooks.json, keeping
every other hook. Without --harness it sets up each harness whose config folder exists. Rerunning
changes nothing; --remove takes out only Pnyx's entries. The hooks print nothing and always exit 0,
so they never add to the agent's context: no session-start Hydra summary is installed.
Hook events go to the default Hydra, or to PNYX_HOME and PNYX_HYDRA when a session has them.
setup service installs one macOS login service running the server of every Hydra; it replaces the older one-per-Hydra services.
setup hydra makes the Firstmate home the Hydra, copies the pnyx-hydra skill into the home's
.agents/skills (kept out of the clone through .git/info/exclude) and leaves Firstmate an inbox note about it.
Firstmate's own files are not changed.
`,
  repair: `usage: pnyx-axi repair [--hydra <name>]
A crash mid-append can leave a torn last line; writes refuse until it is repaired.
Repair copies the torn bytes to a side file and appends a marker so readers skip them; the log is never cut.
`,
  serve: `usage: pnyx-axi serve [--port <n>] [--hydra <name>] [--home <Firstmate path>]...
Serves every Hydra in PNYX_HOME on 127.0.0.1 port 4747 (--port overrides it; 0 picks a random one) until SIGINT, SIGTERM or \`pnyx-axi stop\`.
Each Hydra lives at /hydra/<id>/; / opens the --hydra Hydra. A Hydra that fails to load is skipped and reported, and a Hydra created
while the server runs is served once its folder appears. --hydra names the Hydra whose address is printed (default: default); it and
the default Hydra must load. A Hydra run by a Firstmate home watches that home and replies through it. Each --home is a Firstmate home
for the --hydra Hydra instead: replies to its cards go through it, and its tasks are folded in as \`pnyx-axi firstmate watch\` would.
Hook events arrive on each Hydra's server.sock or through its spool. Browsers get one WebSocket per Hydra at /hydra/<id>/ws:
a snapshot on connect, then events by sequence; ?after=<seq> resumes, a gap gets a fresh snapshot.
The handshake needs ?token=<token>: each Hydra page served here carries it, local programs read $PNYX_HOME/token.
Commands go over the same socket: {"type":"command","id":"<id>","name":"move|link|outcome|undo|rule|account","args":[...]}
gets {"type":"receipt","id":"<id>",...} or {"type":"error","id":"<id>",...}. They always write that socket's Hydra;
--hydra is refused and the actor defaults to web. GET /hydra/<id>/health answers {"hydraId","pid","build"};
GET /health answers {"pid","build","hydras","skipped"}.
`,
  stop: `usage: pnyx-axi stop
Stops the one server of every Hydra. A login service starts it again; \`pnyx-axi setup service --remove\` keeps it stopped.
`,
}

export function commandHelp({ command }: { command: string }): string | undefined {
  if (command === 'layout') {
    return 'usage: pnyx-axi layout show|reset [--hydra <name>] [--if-revision <view revision>]'
  }

  if (command === 'view') {
    return 'usage: pnyx-axi view show|schema|set [--json <patch>] [--if-revision <n>] [--event-id <id>] [--hydra <name>]'
  }

  return COMMAND_HELP[command]
}
