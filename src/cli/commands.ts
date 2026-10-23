import { checkWorkerNotes, workerNotesNotice } from '../memory/workers.ts'
import { requireSetupHome } from '../setup/home.ts'
import { mergeCommand } from '../landing/merge.ts'
import { taskLandingCommand } from '../landing/task-landing.ts'
import { buildCommand, reportCommand } from '../investigation/cli.ts'
import { parseKind } from '../investigation/report.ts'
import { refuseEarlyDone } from '../landing/done.ts'
import { taskSpend } from '../spend/tasks.ts'
import { staleLearnings } from '../memory/learnings.ts'
import { ownerAsk, taskInstructions } from '../core/intent.ts'
import { setupCheckOutput } from '../setup/check.ts'
import { projectWorkerContext } from '../projects/context.ts'
import { decideQueue } from '../queue/decide.ts'
import { queuePosition, workerQueue } from '../queue/state.ts'
import { mentionContext, REFERENCE, referenceLabel } from '../mentions/mentions.ts'
import { IMAGE, imageNames } from '../attachments/images.ts'
import { FILE_BLOCK } from '../attachments/files.ts'
import { reminderTime } from '../reminders/time.ts'
import { waitingReminders } from '../reminders/state.ts'
import { findProject, projectRows, taskProject } from '../projects/read.ts'
import { MAX_DONE_HOURS } from '../core/retention.ts'
import { hideDone } from '../store/retention.ts'
import { setupService } from '../server/service.ts'
import { setupSkills } from '../integrations/skills/install.ts'
import { DEFAULT_VIEW, DEFAULT_WIDTHS, resetLayoutWidths, viewFor } from '../core/view.ts'
import { checkBudget, HYDRA_MEMORY_BUDGET, memorySize, OWNER_DOCUMENTS, OWNER_MEMORY_BUDGET, type Memory } from '../core/digest.ts'
import { ownerMemory, ownerRevision, saveOwnerMemory } from '../store/owner-memory.ts'
import { createHash, randomUUID } from 'node:crypto'
import { sendReply } from './reply.ts'
import { askCommand, askRows } from './asks.ts'
import { findSession, interactive, liveTask, rankOf, selfSession } from '../core/tasks.ts'
import { paseoStatus } from '../integrations/paseo/launch.ts'
import { setupHydra, startHydra, startTask } from './start.ts'
import { OVERRIDE_FIELDS, overrideOf, type Override } from '../dispatch/select.ts'
import { copyCommand } from '../copies/cli.ts'
import { POOL_IDLE } from '../copies/copies.ts'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { hydraConfig, declareTask, declaredState, hydraEvent, HYDRA_CARD, LOCKED_DELETE, lockedColumn, hydraDelivery, reportActor, validateColumns } from '../core/hydra.ts'
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
  ownerActor,
  type HydraEvent,
  type LandingRule,
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
import { showsUpdate, tagsTask } from '../core/updates.ts'
import { HARNESSES, type Harness } from '../integrations/hooks/observe.ts'
import { pullRequestNote } from '../integrations/github/pull-request.ts'
import { canonical } from '../store/paths.ts'
import { DEFAULT_HYDRA, hydraDir, hydraIds, loadHydra, readEvents, repairHydra, spoolFiles, withWriter, type Writer } from '../store/hydra-store.ts'

const HISTORY_LIMIT = 20
const HISTORY_MAX = 100
const HOME_LIMIT = 50
// Hydra's own changes to tasks carry one short why; the owner's direct actions need none.
const EXPLAINED: readonly EventType[] = [
  'card.moved',
  'task.created',
  'task.brief',
  'task.intent',
  'task.visibility',
  'task.reminder',
]

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

export function parse({
  args,
  options,
  positionals,
}: {
  args: string[]
  options: Options
  positionals: number
}) {
  let parsed

  try {
    parsed = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    throw new AxiError(
      (error as Error).message,
      'VALIDATION_ERROR',
      ['Run the command with --help'],
    )
  }

  if (parsed.positionals.length > positionals) {
    throw new AxiError(
      `unexpected argument: ${parsed.positionals[positionals]}`,
      'VALIDATION_ERROR',
      ['Run the command with --help'],
    )
  }

  const values = parsed.values as Record<string, string | boolean | undefined>

  return {
    values,
    positionals: parsed.positionals,
    hydraId: (values.hydra as string | undefined) ?? DEFAULT_HYDRA,
  }
}

export function required({
  value,
  what,
}: {
  value: string | undefined
  what: string
}): string {
  if (!value) {
    throw new AxiError(
      `missing ${what}`,
      'VALIDATION_ERROR',
      ['Run the command with --help'],
    )
  }

  return value
}

export function integer({
  value,
  flag,
}: {
  value: string | boolean | undefined
  flag: string
}): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AxiError(
      `${flag} must be a non-negative integer`,
      'VALIDATION_ERROR',
    )
  }

  return Number(value)
}

export function meta({ values }: { values: Record<string, string | boolean | undefined> }): Meta {
  const m: Meta = {
    at: new Date().toISOString(),
    actor: (values.actor as string | undefined) ?? (process.env.PNYX_ACTOR || 'cli'),
  }

  if (typeof values.reason === 'string') {
    m.reason = values.reason
  }

  if (typeof values.details === 'string' && values.details.trim()) {
    m.details = values.details
  }

  if (typeof values['event-id'] === 'string') {
    m.id = values['event-id']
  }

  const ifRevision = integer({
    value: values['if-revision'],
    flag: '--if-revision',
  })

  if (ifRevision !== undefined) {
    m.ifRevision = ifRevision
  }

  return m
}

// Returns the trimmed reason, which is empty only for writes that are not Hydra's.
export function explained({ meta }: { meta: Meta }): string {
  const reason = meta.reason?.trim() ?? ''

  if (meta.actor === HYDRA_ACTOR && !reason) {
    throw new HydraError({
      message: 'Hydra changes need --reason <why>',
      code: 'VALIDATION_ERROR',
      help: ['Repeat the command with --reason "<one short line on why>"; Pnyx keeps it on the event'],
    })
  }

  return reason
}

function receipt({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): Output {
  if (event.type === 'hydra.project') {
    return {
      event: {
        seq: event.seq,
        id: event.id,
        type: event.type,
      },
      project: event.data.after,
      revision: state.projectsRevision,
    }
  }

  if (event.type === 'hydra.memory') {
    return {
      event: {
        seq: event.seq,
        id: event.id,
        type: event.type,
      },
      memory: event.data.key,
      state: event.data.after === null ? 'forgotten' : 'saved',
    }
  }

  if (event.type === 'board.configured' || event.type === 'board.columns' || event.type === 'board.agents') {
    return {
      event: {
        seq: event.seq,
        id: event.id,
        type: event.type,
      },
      hydra: state.config,
      revision: state.configRevision,
    }
  }

  if (event.type === 'hydra.message') {
    return {
      event: {
        seq: event.seq,
        id: event.id,
        type: event.type,
      },
      message: event.id,
      hydra: event.data.hydra,
      state: 'queued',
      help: ['Hydra can read this in `pnyx-axi hydra messages`; no worker was launched'],
    }
  }

  if (event.type === 'board.view') {
    return {
      event: {
        seq: event.seq,
        id: event.id,
        type: event.type,
      },
      viewRevision: state.viewRevision,
    }
  }

  const card = state.cards[event.cardId]!

  return {
    event: {
      seq: event.seq,
      id: event.id,
      type: event.type,
    },
    card: {
      id: card.id,
      column: card.column,
      revision: card.revision,
    },
  }
}

interface Intent {
  type: EventType
  card: string
}

function confirmationPreview({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): Output {
  if (event.type === 'hydra.project') {
    return {
      project: event.data.after,
      hydras: event.data.sharedWith,
    }
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
    const {
      columns,
      placements,
      fallback,
    } = event.data
    const before = hydraConfig({ state }).columns

    return {
      from: before.map(c => c.id),
      to: columns.map(c => c.id),
      removed: before.filter(c => !columns.some(next => next.id === c.id)).map(c => c.id),
      affectedCards: Object.keys(placements ?? {}).length,
      ...(fallback ? { fallback } : {}),
    }
  }

  return {
    type: event.type,
    target: event.cardId,
  }
}

// The receipt the event with this id got when it was appended. An id already used
// for another card or event type is a conflict, not a retry.
function originalReceipt(
  {
    hydraId,
    state,
    id,
    seq,
    intent,
  }: {
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
    throw new AxiError(
      `event id ${id} was already used by ${original.type} on card ${original.cardId}`,
      'IDEMPOTENCY_CONFLICT',
      ['Retry with a new --event-id'],
    )
  }

  return {
    ...receipt({
      state: replay({
        state: emptyHydra(),
        events: events.slice(
          0,
          index + 1,
        ),
      }),
      event: original,
    }),
    duplicate: 'event id already applied; nothing appended',
  }
}

// A repeated --event-id answers with the original receipt before any other check,
// so a retry of a write that already landed never reports a conflict.
export function commit(
  {
    hydraId,
    meta,
    intent,
    decide,
    confirmation,
    create,
    prepare,
  }: {
    hydraId: string
    create?: boolean
    meta: Meta
    intent: Intent
    // Writes that must come first, under the same lock, once the decision stands; it is then made again on their state.
    prepare?: ({ writer }: { writer: Writer }) => void
    decide: ({
      state,
      meta,
    }: {
      state: HydraState
      meta: Meta
    }) => Decision
    confirmation?: {
      token?: string
      when?({ event }: { event: HydraEvent }): boolean
    }
  },
): Output {
  if (EXPLAINED.includes(intent.type)) {
    explained({ meta })
  }

  return withWriter({
    hydraId,
    create,
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
        const original = readEvents({ hydraId }).find(event => event.id === meta.id)

        if (original?.type === 'hydra.memory' && original.data.key === 'workers') {
          workerNotesNotice({
            writer,
            target: `Hydra ${hydraId}`,
            meta: original,
          })
        }
      } else {
        let decision = decide({
          state: writer.state,
          meta,
        })

        if ('event' in decision && prepare) {
          prepare({ writer })
          decision = decide({
            state: writer.state,
            meta: {
              ...meta,
              ifRevision: undefined,
            },
          })
        }

        if ('event' in decision && decision.event.type === 'task.session' && decision.event.data.before) {
          harvestTranscripts({
            writer,
            cardIds: [decision.event.data.before],
            at: meta.at,
          })
          decision = decide({
            state: writer.state,
            meta: {
              ...meta,
              ifRevision: undefined,
            },
          })
        }

        if ('event' in decision) {
          const needsConfirmation = confirmation
            && (!confirmation.when || confirmation.when({ event: decision.event }))

          if (needsConfirmation) {
            const {
              type,
              cardId,
              data,
            } = decision.event
            const revision = cardId === '$projects' ? writer.state.projectsRevision ?? 0
              : cardId === '$board' ? writer.state.configRevision ?? 0 : writer.state.cards[cardId]?.revision ?? 0
            const token = createHash('sha256').update(JSON.stringify({
              hydraId,
              actor: meta.actor,
              type,
              cardId,
              data,
              revision,
            }))
              .digest('hex')
              .slice(
                0,
                24,
              )

            if (confirmation.token !== token) {
              return {
                confirmation: 'needed',
                token,
                action: summarize({ event: decision.event }),
                preview: confirmationPreview({
                  state: writer.state,
                  event: decision.event,
                }),
                help: ['Repeat the same command with --confirm <token>; a changed target needs a new confirmation'],
              }
            }
          }

          writer.append({ event: decision.event })
          const { event } = decision

          if (event.type === 'hydra.memory' && event.data.key === 'workers') {
            workerNotesNotice({
              writer,
              target: `Hydra ${hydraId}`,
              meta: event,
            })
          }

          out = receipt({
            state: writer.state,
            event,
          })

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
      throw new AxiError(
        error.message,
        error.code,
        error.help,
      )
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
  return (value.startsWith('custom:') ? value : value.replace(
    /-/g,
    '_',
  )) as Column
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

export async function home(): Promise<Output> {
  hideDone({ hydraId: DEFAULT_HYDRA })
  const {
    dir,
    state,
    tornBytes,
  } = loadHydra({ hydraId: DEFAULT_HYDRA })
  const cards = Object.values(state.cards).filter(card => liveTask({ card }))
  const config = hydraConfig({ state })
  const columns = Object.fromEntries(
    config.columns.map(c => [
      c.id,
      cards.filter(card => card.column === c.id).length,
    ]),
  )
  const server = await readServer({ hydraId: DEFAULT_HYDRA })
  const out: Output = {
    projects: projectRows({ state }),
    hydraId: DEFAULT_HYDRA,
    hydra: config.hydra.id,
    server: server ? `running at ${server.url}` : 'not running',
    columns,
  }

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
    out.help = [
      'Run `pnyx-axi task create --title <title>` to add work',
      ...serveHint,
    ]

    return out
  }

  const order = ({ c }: { c: Card }) => config.columns.findIndex(column => column.id === c.column)
  const sorted = cards.sort((
    a,
    b,
  ) => order({
    c: a,
  }) - order({
    c: b,
  }) || rankOf({ card: a }) - rankOf({ card: b }))
  out.cards = sorted.slice(
    0,
    HOME_LIMIT,
  ).map(card => cardRow({ card }))
  out.help = [
    'Run `pnyx-axi card <id>` for details',
    'Run `pnyx-axi history` for recent events',
    ...serveHint,
  ]

  if (sorted.length > HOME_LIMIT) {
    out.more = `${sorted.length - HOME_LIMIT} more cards not shown`
  }

  return out
}

const push = guard({
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
      input = JSON.parse(readFileSync(
        file === '-' ? 0 : file,
        'utf8',
      ))
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

function startOverride({ values }: { values: Record<string, unknown> }): Override | undefined {
  const { fast } = values

  if (fast !== undefined && fast !== 'on' && fast !== 'off') {
    throw new HydraError({
      message: '--fast takes on or off',
      code: 'VALIDATION_ERROR',
    })
  }

  const named = OVERRIDE_FIELDS.filter(name => name !== 'fast' && values[name] !== undefined)
  const empty = named.find(name => !String(values[name]).trim())

  if (empty) {
    throw new HydraError({
      message: `--${empty} needs a value`,
      code: 'VALIDATION_ERROR',
    })
  }

  return overrideOf({
    value: Object.fromEntries([
      ...named.map(name => [
        name,
        values[name],
      ]),
      ...(fast === undefined ? [] : [
        [
          'fast',
          fast === 'on',
        ],
      ]),
    ]),
  })
}

// A paused worker's --until takes the same times as a reminder.
function untilTime({
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

function taskCommand({ args }: { args: string[] }): Output | Promise<Output> {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      title: { type: 'string' },
      project: { type: 'string' },
      brief: { type: 'string' },
      ask: { type: 'string' },
      message: { type: 'string' },
      key: { type: 'string' },
      folder: { type: 'string' },
      session: { type: 'string' },
      'replace-session': { type: 'string' },
      parent: { type: 'string' },
      column: { type: 'string' },
      note: { type: 'string' },
      limit: { type: 'string' },
      before: { type: 'string' },
      behind: { type: 'string' },
      full: { type: 'boolean' },
      harness: { type: 'string' },
      prompt: { type: 'string' },
      'paseo-url': { type: 'string' },
      check: { type: 'boolean' },
      via: { type: 'string' },
      command: { type: 'string' },
      rule: { type: 'string' },
      answer: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      mode: { type: 'string' },
      fast: { type: 'string' },
      'in-place': { type: 'boolean' },
      safe: { type: 'boolean' },
      discard: { type: 'boolean' },
      question: { type: 'string' },
      context: { type: 'string' },
      choice: {
        type: 'string',
        multiple: true,
      },
      recommend: { type: 'string' },
      'details-file': { type: 'string' },
      text: { type: 'string' },
      to: { type: 'string' },
      undelivered: { type: 'boolean' },
      'from-message': { type: 'string' },
      kind: { type: 'string' },
      file: { type: 'string' },
      url: { type: 'string' },
      landing: { type: 'string' },
      merge: { type: 'string' },
      clear: { type: 'boolean' },
      until: { type: 'string' },
      hold: { type: 'boolean' },
    },
    positionals: 4,
  })
  const action = positionals[0]
  const m = meta({ values })
  const url = values['paseo-url'] as string | undefined

  if (action === 'report') {
    return reportCommand({
      hydraId,
      ref: positionals[1],
      file: values.file as string | undefined,
      meta: m,
    })
  }

  if (action === 'build') {
    return buildCommand({
      hydraId,
      ref: positionals[1],
      meta: m,
    })
  }

  if (action === 'landing') {
    return taskLandingCommand({
      hydraId,
      ref: positionals[1],
      landing: values.landing as string | undefined,
      merge: values.merge as string | undefined,
      clear: values.clear === true,
      meta: m,
    })
  }

  if (action === 'merge') {
    return mergeCommand({
      hydraId,
      ref: positionals[1],
      url: values.url as string | undefined,
      meta: m,
    })
  }

  if (action === 'reminders') {
    const reminders = waitingReminders({ state: loadHydra({ hydraId }).state })

    return {
      hydraId,
      count: reminders.length,
      reminders: reminders.length ? reminders : 'none: no waiting reminders',
    }
  }

  if (action === 'remind') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const when = required({
      value: positionals[2],
      what: 'reminder time or clear',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.reminder',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({
            message: 'Choose a task for the reminder',
            code: 'VALIDATION_ERROR',
          })
        }

        const after = when === 'clear' ? null : reminderTime({
          when,
          now: m.at,
        })

        return after === (task.reminder?.at ?? null) && !task.reminder?.dueAt ? { skipped: 'unchanged' }
          : hydraEvent({
            state,
            meta: m,
            cardId: task.id,
            change: {
              type: 'task.reminder',
              data: {
                before: task.reminder?.at ?? null,
                after,
              },
            },
          })
      },
    })
  }

  if (action === 'permission') {
    const reason = explained({ meta: m })
    const choice = positionals[3]

    if (choice !== 'allow' && choice !== 'deny') {
      // A quoted "<task> <request>" arrives as one argument, so say what was parsed.
      const got = positionals.slice(1).map(arg => `'${arg}'`)
        .join(' ') || 'nothing'

      throw new HydraError({
        message: `Use task permission <task> <request> allow|deny (got ${got})`,
        code: 'VALIDATION_ERROR',
        help: ['Pass the task, the request id and allow or deny as separate arguments'],
      })
    }

    let answer: unknown

    try {
      answer = typeof values.answer === 'string' ? JSON.parse(values.answer) : undefined
    } catch {
      throw new HydraError({
        message: '--answer must be JSON',
        code: 'VALIDATION_ERROR',
      })
    }

    return askHost({
      hydraId,
      body: {
        action: 'permission',
        task: required({
          value: positionals[1],
          what: 'task id',
        }),
        request: required({
          value: positionals[2],
          what: 'request id',
        }),
        choice,
        ...(answer !== undefined ? { answer } : {}),
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
    return askHost({
      hydraId,
      body: {
        action: 'continue',
        task: required({
          value: positionals[1],
          what: 'task id',
        }),
        check: true,
        id: m.id ?? randomUUID(),
        actor: m.actor,
      },
    })
  }

  if (action === 'start' || action === 'continue') {
    explained({ meta: m })
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const started = action === 'continue' ? askHost({
      hydraId,
      body: {
        action: 'continue',
        task: ref,
        id: m.id ?? randomUUID(),
        actor: m.actor,
        ...(m.reason ? { reason: m.reason } : {}),
      },
    }) : startTask({
      hydraId,
      task: ref,
      replacement: values['replace-session'] as string | undefined,
      commandName: values.command as string | undefined,
      via: values.via as string | undefined,
      rule: values.rule as string | undefined,
      harness: values.harness as string | undefined,
      override: startOverride({ values }),
      prompt: values.prompt as string | undefined,
      folder: values.folder as string | undefined,
      inPlace: Boolean(values['in-place']),
      url,
      meta: m,
    })

    return started
  }

  if (action === 'copy') {
    return copyCommand({
      hydraId,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
      action: positionals[2],
      values,
      meta: m,
    })
  }

  if (action === 'sessions') {
    const sessions = Object.values(loadHydra({ hydraId }).state.sessions ?? {}).map(s => ({
      id: s.id,
      provider: s.agent.provider,
      task: s.taskId ?? 'none',
      interactive: interactive({ session: s }),
    }))

    return { sessions: sessions.length ? sessions : 'none: no sessions recorded' }
  }

  if (action === 'create') {
    const title = required({
      value: values.title as string | undefined,
      what: '--title',
    }).trim()
    required({
      value: title,
      what: '--title',
    })
    const key = values.key as string | undefined ?? `task:${m.id ?? randomUUID()}`

    if (key.startsWith('$')) {
      throw new HydraError({
        message: 'task keys beginning with $ are reserved',
        code: 'VALIDATION_ERROR',
      })
    }

    const folder = canonical({ path: values.folder })
    const brief = taskBrief({ value: values.brief })
    const kind = values.kind === undefined ? 'build' : parseKind({ value: String(values.kind) })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.created',
        card: key,
      },
      decide: ({ state }) => {
        if (state.keys[key]) {
          throw new HydraError({
            message: `task key already exists: ${key}`,
            code: 'CONFLICT',
          })
        }

        const project = values.project
          ? taskProject({
            state,
            ref: String(values.project),
          }) : undefined
        const parent = values.parent ? findCard({
          state,
          ref: String(values.parent),
        }) : undefined

        if (parent?.parentId || parent?.automaticTask || parent?.id === HYDRA_CARD) {
          throw new HydraError({
            message: 'subtasks have one level under a task',
            code: 'VALIDATION_ERROR',
          })
        }

        const columns = hydraConfig({
          state,
          id: hydraId,
        }).columns
        const selected = values.column
          ? columns.find(c => c.id === values.column || c.title === values.column
            || c.role === values.column) : undefined

        if (values.column && !selected) {
          throw new HydraError({
            message: 'unknown Hydra column',
            code: 'VALIDATION_ERROR',
          })
        }

        const cardId = `task-${randomUUID()}`
        const created: TaskCreated['data'] = {
          key,
          title,
          ...(project ? { project } : {}),
          ...(brief !== undefined ? { brief } : {}),
          ...(folder ? { folder } : {}),
          ...(parent ? { parentId: parent.id } : {}),
          ...(selected ? { column: selected.id } : {}),
        }

        // A build task, the default, records no kind.
        if (kind === 'investigation') {
          created.kind = kind
        }

        const ask = values.ask

        if (ask !== undefined && String(ask).trim()) {
          created.ask = ownerAsk({
            state,
            text: String(ask),
            message: values.message as string | undefined,
            actor: m.actor,
            at: m.at,
          })
        }

        return hydraEvent({
          state,
          meta: m,
          cardId,
          change: {
            type: 'task.created',
            data: created,
          },
        })
      },
    })
  }

  if (action === 'queue' || action === 'unqueue' || action === 'reorder') {
    const task = required({
      value: positionals[1],
      what: 'task id',
    })
    const behind = action === 'unqueue' ? undefined : required({
      value: values.behind as string | undefined,
      what: '--behind <task|session>',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.queue',
        card: task,
      },
      decide: ({ state }) => {
        if (action === 'reorder' && !findCard({
          state,
          ref: task,
        }).queue) {
          throw new HydraError({
            message: 'only a queued task can be reordered',
            code: 'CONFLICT',
          })
        }

        return decideQueue({
          state,
          task,
          behind,
          meta: m,
        })
      },
    })
  }

  if (action === 'list') {
    hideDone({ hydraId })
    const state = loadHydra({ hydraId }).state

    const tasks = Object.values(state.cards).filter(c => liveTask({ card: c }))
      .map(c => ({
        ...cardRow({ card: c }),
        parent: c.parentId ?? '',
        status: c.status?.state ?? 'paused',
        worker: c.sessionIds?.[0] ?? '',
        ...(c.queue ? {
          queue: queuePosition({
            state,
            card: c,
          }),
        } : {}),
      }))

    return tasks.length
      ? {
        hydraId,
        tasks,
        help: [`Run \`pnyx-axi task show <id> --hydra ${hydraId}\` for one task`],
      }
      : {
        hydraId,
        tasks: 'none: no tasks on this Hydra',
        help: [`Run \`pnyx-axi task create --title <title> --hydra ${hydraId}\` to add one`],
      }
  }

  if (action === 'history') {
    return taskHistory({
      hydraId,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
      before: integer({
        value: values.before,
        flag: '--before',
      }),
      limit: integer({
        value: values.limit,
        flag: '--limit',
      }) ?? HISTORY_LIMIT,
      full: Boolean(values.full),
    })
  }

  if (action === 'show') {
    const state = loadHydra({ hydraId }).state
    const task = findCard({
      state,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
    })

    const spend = taskSpend({
      state,
      events: readEvents({ hydraId }),
      task: task.id,
    })

    if (values.full) {
      return {
        task,
        spend,
        worker: task.sessionIds?.[0] ? state.sessions?.[task.sessionIds[0]] : undefined,
      }
    }

    return {
      task: {
        ...cardRow({ card: task }),
        key: task.key,
        ...(task.copy ? { copy: `${task.copy.path} (${task.copy.state}${task.copy.reason ? `: ${task.copy.reason}` : ''})` } : {}),
        ask: task.ask?.length ? task.ask : 'none: no owner words recorded',
        spend,
        brief: task.brief ?? 'none',
        parent: task.parentId ?? 'none',
        status: task.status ? `${declaredState({ declaration: task.status })}${task.status.note ? `: ${task.status.note}` : ''}` : 'none: no declaration yet',
        worker: task.sessionIds?.[0] ?? 'none',
        ...(task.queue ? {
          queue: queuePosition({
            state,
            card: task,
          }),
        } : {}),
        ...(task.queueNote ? { handoff: task.queueNote } : {}),
        next: task.sessionIds?.[0] ? workerQueue({
          state,
          session: task.sessionIds[0],
        }).map(c => ({
          id: c.id,
          title: c.title,
          ...queuePosition({
            state,
            card: c,
          }),
        })) : [],
        declarations: task.statusLog?.length ?? 0,
        ...(task.asks?.length ? { questions: askRows({ card: task }) } : {}),
        firstmate: task.mirror ? 'mirrored' : 'none',
      },
      help: [`Run \`pnyx-axi task show ${task.id} --full --hydra ${hydraId}\` for the full record, or \`pnyx-axi task history ${task.id} --hydra ${hydraId}\` for its events`],
    }
  }

  if (action === 'chat') {
    const state = loadHydra({ hydraId }).state
    const task = findCard({
      state,
      ref: required({
        value: positionals[1],
        what: 'task id',
      }),
    })
    const session = values.session ? findSession({
      state,
      ref: String(values.session),
    }) : undefined

    if (session && !taskSessions({
      hydraId,
      ids: new Set([task.id]),
    }).has(session.id)) {
      throw new HydraError({
        message: 'this session has no recorded membership on the task',
        code: 'NOT_FOUND',
      })
    }

    const card = session ? {
      ...task,
      agent: session.agent,
      sessionIds: [session.id],
    } : task

    return {
      thread: readThread({
        hydraId,
        state,
        card,
        homes: [],
        before: values.before as string | undefined,
      }),
    }
  }

  if (action === 'project') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const project = required({
      value: values.project as string | undefined,
      what: '--project <name|path>',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.project',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })
        const after = findProject({
          state,
          ref: project,
          attached: true,
        }).path

        return task.project === after ? { skipped: 'unchanged' }
          : hydraEvent({
            state,
            meta: m,
            cardId: task.id,
            change: {
              type: 'task.project',
              data: {
                before: task.project ?? null,
                after,
              },
            },
          })
      },
    })
  }

  if (action === 'status') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    if (positionals[2] === 'done') {
      const state = loadHydra({ hydraId }).state
      refuseEarlyDone({
        state,
        card: findCard({
          state,
          ref,
        }),
        hydraId,
      })
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.declared',
        card: ref,
      },
      decide: ({ state }) => declareTask({
        state,
        ref,
        status: required({
          value: positionals[2],
          what: 'status',
        }),
        note: String(values.note ?? ''),
        meta: m,
        until: untilTime({
          until: values.until as string | undefined,
          now: m.at,
        }),
        hold: values.hold as boolean | undefined,
      }),
    })
  }

  if (action === 'hide-after') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })
    const raw = required({
      value: positionals[2],
      what: 'hours or default',
    }).trim()
    const after = raw === 'default' ? null : Number(raw)

    if (after !== null
      && (!raw || !Number.isFinite(after) || after < 0 || after > MAX_DONE_HOURS)) {
      throw new HydraError({
        message: `use hours from 0 to ${MAX_DONE_HOURS}, or default (0 keeps the card visible)`,
        code: 'VALIDATION_ERROR',
      })
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.retention',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({
            message: 'choose a task',
            code: 'VALIDATION_ERROR',
          })
        }

        const before = task.doneAfterHours ?? null

        return before === after && !task.keepDone ? { skipped: 'unchanged' }
          : hydraEvent({
            state,
            meta: m,
            cardId: task.id,
            change: {
              type: 'task.retention',
              data: {
                before,
                after,
              },
            },
          })
      },
    })
  }

  if (action === 'intent') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'task.intent',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({
            message: 'Choose a task for the owner ask',
            code: 'VALIDATION_ERROR',
          })
        }

        const entry = ownerAsk({
          state,
          text: required({
            value: values.text as string | undefined,
            what: '--text',
          }),
          message: values.message as string | undefined,
          actor: m.actor,
          at: m.at,
        })

        const recorded = task.ask?.some(ask => ask.message === entry.message
          && ask.text === entry.text)

        if (entry.message && recorded) {
          return { skipped: 'unchanged' }
        }

        return hydraEvent({
          state,
          meta: m,
          cardId: task.id,
          change: {
            type: 'task.intent',
            data: entry,
          },
        })
      },
    })
  }

  if (action === 'brief' || action === 'hide' || action === 'unhide') {
    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: action === 'brief' ? 'task.brief' : 'task.visibility',
        card: ref,
      },
      decide: ({ state }) => {
        const task = findCard({
          state,
          ref,
        })

        if (task.automaticTask || task.id === HYDRA_CARD) {
          throw new HydraError({
            message: 'choose a task',
            code: 'VALIDATION_ERROR',
          })
        }

        if (action === 'brief') {
          const after = taskBrief({ value: values.brief })

          if (after === undefined) {
            throw new HydraError({
              message: 'pass --brief <text> (empty text clears it)',
              code: 'VALIDATION_ERROR',
            })
          }

          return after === (task.brief ?? '') ? { skipped: 'unchanged' } : hydraEvent({
            state,
            meta: m,
            cardId: task.id,
            change: {
              type: 'task.brief',
              data: {
                before: task.brief ?? '',
                after,
              },
            },
          })
        }

        const after = action === 'hide'

        return Boolean(task.hidden) === after ? { skipped: 'unchanged' } : hydraEvent({
          state,
          meta: m,
          cardId: task.id,
          change: {
            type: 'task.visibility',
            data: {
              before: Boolean(task.hidden),
              after,
            },
          },
        })
      },
    })
  }

  if (action === 'rename') {
    if (values.title === undefined && values.project === undefined) {
      throw new HydraError({
        message: 'pass --title or --project (empty text clears the label)',
        code: 'VALIDATION_ERROR',
      })
    }

    const ref = required({
      value: positionals[1],
      what: 'task id',
    })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.pushed',
        card: ref,
      },
      decide: ({ state }) => decidePush({
        state,
        key: findCard({
          state,
          ref,
        }).key,
        input: {
          ...(values.title !== undefined ? {
            title: required({
              value: values.title as string,
              what: '--title',
            }),
          } : {}),
          ...(values.project !== undefined ? { project: values.project } : {}),
        },
        meta: m,
      }),
    })
  }

  if (action === 'ask' || action === 'answer' || action === 'escalate') {
    return askCommand({
      action,
      positionals,
      values,
      hydraId,
      meta: m,
    })
  }

  if (action !== 'attach' && action !== 'detach') {
    throw new AxiError(
      'Use task create, list, show, status, ask, answer, escalate, history, rename, start, copy, permission, paseo, sessions, attach or detach',
      'VALIDATION_ERROR',
    )
  }

  const ref = required({
    value: positionals[1],
    what: 'task id',
  })

  const result = commit({
    hydraId,
    meta: m,
    intent: {
      type: 'task.session',
      card: ref,
    },
    decide: ({
      state,
      meta: current,
    }) => {
      if (!liveTask({
        card: findCard({
          state,
          ref,
        }),
      })) {
        throw new HydraError({
          message: 'choose an explicit task; use hydra set to configure Hydra',
          code: 'VALIDATION_ERROR',
        })
      }

      if (action === 'detach' && !findCard({
        state,
        ref,
      }).sessionIds?.length) {
        return { skipped: 'unchanged' }
      }

      const session = action === 'attach'
        ? sessionRef({
          state,
          ref: required({
            value: values.session as string | undefined,
            what: '--session',
          }),
        })
        : findSession({
          state,
          ref,
        }).id

      return decideSession({
        state,
        ref: session,
        task: action === 'attach' ? ref : null,
        meta: current,
      })
    },
  })

  if (action === 'attach' && typeof result.event === 'object' && result.event !== null && 'id' in result.event) {
    const eventId = result.event.id
    const attachment = readEvents({ hydraId }).find(e => e.id === eventId)

    if (attachment?.type === 'task.session') {
      return afterAttach({
        hydraId,
        result,
        attachment,
        meta: m,
      })
    }
  }

  return result
}

type Attachment = Extract<HydraEvent, { type: 'task.session' }>
type TaskCreated = Extract<HydraEvent, { type: 'task.created' }>

// Attachment is durable even when delivery fails.
async function afterAttach({
  hydraId,
  result,
  attachment,
  meta,
}: {
  hydraId: string
  result: Output
  attachment: Attachment
  meta: Meta
}): Promise<Output> {
  if (!attachment.data.brief) {
    return result
  }

  const state = loadHydra({ hydraId }).state
  const home = state.config?.hydra.home
  const context = projectWorkerContext({
    hydraId,
    state,
    project: state.cards[attachment.cardId]?.project,
  })

  try {
    const brief = await sendReply({
      hydraId,
      request: {
        card: attachment.cardId,
        text: [
          context,
          taskInstructions({ card: state.cards[attachment.cardId]! }),
        ].filter(Boolean).join('\n\n'),
        expectedSession: attachment.data.session,
        homes: home ? [home] : [],
        actor: meta.actor,
        id: `brief:${attachment.id}`,
      },
    })

    return {
      ...result,
      brief,
    }
  } catch (error) {
    return {
      ...result,
      brief: {
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      help: ['The attachment was recorded; inspect the task before retrying its brief with the same --event-id'],
    }
  }
}

function taskBrief({ value }: { value: unknown }): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.length > 24000) {
    throw new HydraError({
      message: 'a brief must be text of up to 24000 characters',
      code: 'VALIDATION_ERROR',
    })
  }

  return value
}

const task = guard({ handler: ({ args }) => taskCommand({ args }) })

function sessionRef({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): string {
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

function taskHistory({
  hydraId,
  ref,
  before,
  limit,
  full,
}: {
  hydraId: string
  ref: string
  before?: number
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
  const events = readEvents({ hydraId })
  const sessions = taskSessions({
    hydraId,
    ids,
  })
  const matches = events.filter(e => (before === undefined || e.seq < before) && (ids.has(e.cardId) || (e.type === 'task.session' && (ids.has(e.data.before ?? '') || ids.has(e.data.after ?? ''))) || tagsTask({
    event: e,
    ids,
  })))
    .reverse()
  const page = matches.slice(
    0,
    limit,
  )

  const help = [
    ...(matches.length > limit ? [`Run \`pnyx-axi task history ${ref} --before ${page.at(-1)!.seq} --hydra ${hydraId}\` for older events`] : []),
    ...(full || !page.length ? [] : [`Run \`pnyx-axi task history ${ref} --full --hydra ${hydraId}\` for each event's data`]),
  ]

  return {
    hydraId,
    task: task.id,
    sessions: sessions.size ? [...sessions].map(id => ({
      session: id,
      transcript: state.sessions?.[id]?.agent.transcriptPath ?? 'unavailable',
      command: `pnyx-axi task chat ${task.id} --session ${id} --hydra ${hydraId}`,
    })) : 'none: no agent has worked on this task',
    events: page.length ? page.map(e => ({
      seq: e.seq,
      id: e.id,
      at: e.at,
      type: e.type,
      card: e.cardId,
      actor: e.actor,
      summary: summarize({ event: e }),
      ...(full ? {
        data: e.data,
        reason: e.reason,
        details: e.details,
      } : {}),
    })) : 'none: no matching events',
    ...(matches.length > limit ? { next: page.at(-1)!.seq } : {}),
    ...(help.length ? { help } : {}),
  }
}

function taskSessions({
  hydraId,
  ids,
}: {
  hydraId: string
  ids: Set<string>
}): Set<string> {
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
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      name: { type: 'string' },
      identity: { type: 'string' },
      session: { type: 'string' },
      firstmate: { type: 'string' },
      command: { type: 'string' },
      'command-folder': { type: 'string' },
      base: { type: 'string' },
      'done-after-hours': { type: 'string' },
    },
    positionals: 2,
  })
  const action = positionals[0]

  if (action === 'homes') {
    return firstmateHomes({ base: values.base as string | undefined })
  }

  if (action === 'list') {
    const hydras = hydraIds()

    if (!hydras.length) {
      return {
        hydras: 'none: no Hydras yet',
        help: ['Run `pnyx-axi hydra create <id>` to add one'],
      }
    }

    return {
      hydras: hydras.map(id => {
        hideDone({ hydraId: id })
        const state = loadHydra({ hydraId: id }).state
        const config = hydraConfig({
          state,
          id,
        })

        const tasks = Object.values(state.cards).filter(c => liveTask({ card: c })).length

        return {
          id,
          name: config.name,
          hydra: config.hydra.id,
          kind: config.hydra.kind,
          tasks,
        }
      }),
      help: ['Run `pnyx-axi hydra show --hydra <id>` for its columns and Hydra'],
    }
  }

  const id = action !== 'create'
    ? hydraId
    : positionals[1]
      ?? (values.firstmate ? homeHydraId({ home: String(values.firstmate) }) : required({
        value: undefined,
        what: 'Hydra id',
      }))
  hydraDir({ hydraId: id })

  if (action === 'show') {
    const state = loadHydra({ hydraId: id }).state

    return {
      hydra: hydraConfig({
        state,
        id,
      }),
      projects: projectRows({ state }),
      revision: state.configRevision ?? 0,
    }
  }

  if (action !== 'create' && action !== 'set') {
    throw new HydraError({
      message: 'Use hydra create <id>, list, homes, show or set',
      code: 'VALIDATION_ERROR',
    })
  }

  const m = meta({ values })

  return commit({
    hydraId: id,
    create: action === 'create',
    meta: m,
    intent: {
      type: 'board.configured',
      card: '$board',
    },
    decide: ({ state }) => {
      if (action === 'create' && state.configured) {
        throw new HydraError({
          message: `Hydra already exists: ${id}`,
          code: 'CONFLICT',
        })
      }

      const current = hydraConfig({
        state,
        id,
      })

      if (action === 'create' && !state.config && !Object.keys(state.cards).length) {
        current.columns = current.columns.map(c => ({
          ...c,
          id: `custom:${randomUUID()}`,
        }))
      }

      const identity = String(values.identity ?? current.hydra.id)
      required({
        value: identity.trim(),
        what: '--identity',
      })
      const kept = identity === current.hydra.id ? current.hydra : undefined
      const home = canonical({ path: values.firstmate })

      if (values.firstmate && !home) {
        throw new HydraError({
          message: '--firstmate must be an absolute home path',
          code: 'VALIDATION_ERROR',
        })
      }

      const session = values.session ? findSession({
        state,
        ref: sessionRef({
          state,
          ref: String(values.session),
        }),
      }) : undefined

      if (session && session.taskId && !state.cards[session.taskId]?.automaticTask) {
        throw new HydraError({
          message: 'detach the task worker before making it Hydra',
          code: 'CONFLICT',
        })
      }

      const hydra: HydraIdentity = {
        name: 'Hydra',
        kind: 'agent',
        ...kept,
        id: identity,
        ...(home ? {
          kind: 'firstmate',
          home,
        } : {}),
        ...(session ? { session: session.id } : {}),
      }

      const command = values.command === undefined ? current.command : String(values.command).trim()
      const data: HydraConfig = {
        ...current,
        id,
        name: String(values.name ?? current.name),
        hydra,
      }

      if (values['done-after-hours'] !== undefined) {
        const raw = String(values['done-after-hours']).trim()
        const hours = Number(raw)

        if (!raw || !Number.isFinite(hours) || hours < 0 || hours > MAX_DONE_HOURS) {
          throw new HydraError({
            message: `--done-after-hours must be a number from 0 to ${MAX_DONE_HOURS} (0 keeps Done cards visible)`,
            code: 'VALIDATION_ERROR',
          })
        }

        data.doneAfterHours = hours
      }

      delete data.command

      if (command) {
        data.command = command
      }

      const owns = values['command-folder']

      if (owns !== undefined && owns !== 'own' && owns !== 'copy') {
        throw new HydraError({
          message: '--command-folder must be own or copy',
          code: 'VALIDATION_ERROR',
        })
      }

      if (owns === 'own') {
        data.commandOwnsFolder = true
      } else if (owns === 'copy') {
        delete data.commandOwnsFolder
      }

      return hydraEvent({
        state,
        meta: m,
        cardId: '$board',
        change: {
          type: 'board.configured',
          data,
        },
      })
    },
  })
}

const HYDRA_NAME_MAX = 40

export function hydraName({ text }: { text: string }): string | undefined {
  const lines = text.replace(
    FILE_BLOCK,
    '',
  ).replace(
    new RegExp(
      REFERENCE.source,
      'g',
    ),
    (
      _,
      label: string,
    ) => referenceLabel({ label }),
  )
    .split('\n')
    .map(part => part.trim())
  const index = lines.findIndex(part => part.replace(
    IMAGE,
    '',
  ).trim())

  if (index < 0) {
    return undefined
  }

  const names = imageNames({ text })
  const line = lines[index]!.replace(
    IMAGE,
    (
      _,
      path: string,
    ) => names.get(path) ?? 'Image',
  )

  if (line.length <= HYDRA_NAME_MAX) {
    return line
  }

  // An early space would leave a word or two, so the cut falls mid-word, never inside a surrogate pair.
  const cut = line.slice(
    0,
    HYDRA_NAME_MAX + 1,
  )
  const space = cut.lastIndexOf(' ')
  const end = space >= HYDRA_NAME_MAX / 2 ? space : HYDRA_NAME_MAX
  const words = cut.slice(
    0,
    end,
  ).replace(
    /[\uD800-\uDBFF]$/,
    '',
  )
    .replace(
      /[\s,.;:!?-]+$/,
      '',
    )

  return words ? `${words}…` : undefined
}

function nameHydra({
  hydraId,
  meta,
  text,
}: {
  hydraId: string
  meta: Meta
  text: string
}): void {
  const name = hydraName({ text })

  if (!name) {
    return
  }

  // A retried message retries its naming under the same derived id.
  const naming: Meta = {
    at: meta.at,
    actor: meta.actor,
  }

  if (meta.id) {
    naming.id = `${meta.id}:name`
  }

  try {
    commit({
      hydraId,
      meta: naming,
      intent: {
        type: 'board.configured',
        card: '$board',
      },
      decide: ({
        state,
        meta,
      }) => {
        const config = hydraConfig({
          state,
          id: hydraId,
        })

        return config.name ? { skipped: 'unchanged' } : hydraEvent({
          state,
          meta,
          cardId: '$board',
          change: {
            type: 'board.configured',
            data: {
              ...config,
              name,
            },
          },
        })
      },
    })
  } catch (error) {
    // The message has landed; a busy log only delays the name to the owner's next message.
    if (!(error instanceof HydraError && error.code === 'LOCKED')) {
      throw error
    }
  }
}

function homeHydraId({ home }: { home: string }): string {
  return basename(home).toLowerCase()
    .replace(
      /[^a-z0-9._-]+/g,
      '-',
    )
    .replace(
      /^[^a-z0-9]+/,
      '',
    )
    .slice(
      0,
      64,
    ) || 'firstmate'
}

function firstmateHomes({ base }: { base?: string }): Output {
  const root = base ?? process.env.FIRSTMATE_FACTORY_BASE ?? join(
    homedir(),
    'projects',
    'agentic-engineering-workflow',
  )
  let names: string[] = []

  try {
    names = readdirSync(
      root,
      { withFileTypes: true },
    ).filter(d => d.isDirectory())
      .map(d => d.name)
  } catch { /* No such folder: no homes. */ }

  const homes = names.map(name => join(
    root,
    name,
  )).filter(path =>
    [
      'state',
      'config',
    ].every(dir => existsSync(join(
      path,
      dir,
    ))) && existsSync(join(
      path,
      'bin',
      'fm-send.sh',
    )))
  let hydras: {
    id: string
    home?: string
  }[] = []

  try {
    hydras = hydraIds().map(id => ({
      id,
      home: loadHydra({ hydraId: id }).state.config?.hydra.home,
    }))
  } catch { /* An unreadable Hydra links no home. */ }

  if (!homes.length) {
    return {
      base: root,
      homes: 'none: no Firstmate homes found',
      help: ['Pass --base <folder holding the homes>'],
    }
  }

  const rows = homes.map(home => {
    const real = canonical({ path: home }) ?? home
    const hydraId = hydras.find(b => b.home === real)?.id

    return {
      home: real,
      hydraId: hydraId ?? 'none',
      ...(hydraId ? {} : { create: `pnyx-axi hydra create --firstmate ${real}` }),
    }
  })

  return {
    base: root,
    homes: rows,
    help: ['Each home gets its own Hydra; run the create command of a home without one'],
  }
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
      }).columns,
      revision: state.configRevision ?? 0,
    }
  }

  const m = meta({ values })

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

  return commit({
    hydraId,
    meta: m,
    ...(m.actor !== 'web' && (action === 'delete' || action === 'reorder') ? { confirmation: { token: values.confirm as string | undefined } } : {}),
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
      const selected = columns.find(c => c.id === ref || c.role === ref)

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
        })
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
          ? columns.find(c => c.id === values.to || c.role === values.to)?.id : columns[0]?.id

        if (values.to && !fallback) {
          throw new HydraError({
            message: 'fallback column not found',
            code: 'VALIDATION_ERROR',
          })
        }
      } else if (action === 'reorder') {
        columns = columns.filter(c => c.id !== selected!.id)
        const index = values.before
          ? columns.findIndex(c => c.id === values.before || c.role === values.before)
          : columns.length

        if (index < 0) {
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
          message: 'Use column list, create, rename, describe, resize, delete or reorder',
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

const columnCommandHandler = guard({ handler: ({ args }) => columnCommand({ args }) })

function hydraCommand({ args }: { args: string[] }): Output | Promise<Output> {
  if (args[0] === 'worker-notes') {
    return hydraCommand({
      args: [
        'memory',
        ...args.slice(1),
        '--key',
        'workers',
      ],
    })
  }

  if ([
    'create',
    'list',
    'homes',
    'show',
    'set',
  ].includes(args[0] ?? '')) {
    return hydraConfigCommand({ args })
  }

  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      task: { type: 'string' },
      action: { type: 'string' },
      kind: { type: 'string' },
      key: { type: 'string' },
      width: { type: 'string' },
      text: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      full: { type: 'boolean' },
      via: { type: 'string' },
      rule: { type: 'string' },
      harness: { type: 'string' },
      prompt: { type: 'string' },
      folder: { type: 'string' },
      home: { type: 'string' },
      'paseo-url': { type: 'string' },
    },
    positionals: 2,
  })

  if (positionals[0] === 'resize') {
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

    const m = meta({ values })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state }) => decideView({
        state,
        patch: { hydraWidth: width },
        meta: m,
      }),
    })
  }

  if (positionals[0] === 'memory') {
    const action = positionals[1] ?? 'list'

    if (action === 'list') {
      const state = loadHydra({ hydraId }).state

      return memoryList({
        memory: state.hydraMemory ?? {},
        budget: HYDRA_MEMORY_BUDGET,
        empty: 'none: no Hydra memory yet',
      })
    }

    const {
      key,
      after,
    } = memoryChange({
      action,
      values,
      usage: 'use hydra memory list|set|forget',
    })

    if (after !== null && Object.hasOwn(
      OWNER_DOCUMENTS,
      key,
    )) {
      throw new HydraError({
        message: `${OWNER_DOCUMENTS[key as keyof typeof OWNER_DOCUMENTS]} are Pnyx-wide owner memory`,
        code: 'VALIDATION_ERROR',
        help: [`Run \`pnyx-axi owner memory set --key ${key} --text "<document>"\`, or save a note only this Hydra needs under another key`],
      })
    }

    const m = meta({ values })

    if (key === 'workers') {
      explained({ meta: m })
      checkWorkerNotes({
        text: after,
        reason: m.reason,
      })
    }

    const result = commit({
      hydraId,
      meta: m,
      intent: {
        type: 'hydra.memory',
        card: '$board',
      },
      decide: ({ state }) => {
        const before = state.hydraMemory?.[key]?.text ?? null
        checkBudget({
          memory: state.hydraMemory ?? {},
          key,
          after,
          budget: HYDRA_MEMORY_BUDGET,
          layer: 'Hydra',
        })

        return before === after ? { skipped: 'unchanged' } : hydraEvent({
          state,
          meta: m,
          cardId: '$board',
          change: {
            type: 'hydra.memory',
            data: {
              key,
              before,
              after,
            },
          },
        })
      },
    })

    if (key === 'workers' && result.event === 'none: unchanged') {
      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const saved = readEvents({ hydraId }).findLast(event => event.type === 'hydra.memory'
            && event.data.key === 'workers')

          if (saved) {
            workerNotesNotice({
              writer,
              target: `Hydra ${hydraId}`,
              meta: saved,
            })
          }
        },
      })
    }

    return result
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
    const after = integer({
      value: values.after,
      flag: '--after',
    }) ?? 0
    const limit = Math.min(
      integer({
        value: values.limit,
        flag: '--limit',
      }) ?? HISTORY_LIMIT,
      HISTORY_MAX,
    )

    if (limit < 1) {
      throw new HydraError({
        message: '--limit must be positive',
        code: 'VALIDATION_ERROR',
      })
    }

    const events = readEvents({ hydraId }).filter((e): e is Extract<HydraEvent, { type: 'hydra.message' | 'task.reminder-due' }> => e.seq > after && (e.type === 'hydra.message' || e.type === 'task.reminder-due'))
    const page = events.slice(
      0,
      limit,
    )

    const through = page.at(-1)?.seq ?? after

    return {
      hydra: hydraConfig({
        state,
        id: hydraId,
      }).hydra.id,
      messages: page.length
        ? page.map(e => {
          const data = e.type === 'task.reminder-due' ? e.data.message : e.data

          return values.full ? e : {
            seq: e.seq,
            id: e.id,
            at: e.at,
            actor: e.type === 'task.reminder-due' ? HYDRA_ACTOR : e.actor,
            task: data.task ?? 'none',
            action: data.action,
            text: data.text,
            ...(data.details ? { details: data.details } : {}),
            ...('context' in data && data.context ? { context: data.context } : {}),
          }
        })
        : `none: no messages after seq ${after}`,
      through,
      ...(events.length > limit ? { help: [`Run \`pnyx-axi hydra messages --after ${through} --hydra ${hydraId}\` for the next page`] } : { help: [`Run \`pnyx-axi hydra messages --after ${through} --hydra ${hydraId}\` later for new messages`] }),
    }
  }

  if (positionals[0] === 'stop' || positionals[0] === 'usage') {
    const action = positionals[0]

    return readServer({ hydraId }).then(server => server ? askHost({
      hydraId,
      body: {
        action,
        actor: meta({ values }).actor,
      },
    }) : { [action === 'stop' ? 'stopped' : 'usage']: 'none: no Pnyx server runs this Hydra' })
  }

  if (positionals[0] !== 'send') {
    throw new HydraError({
      message: 'Use hydra send --text <message>, hydra send --task <id> [--action send|worker], hydra send --task <id> --kind progress --text <message>, hydra stop, hydra usage or hydra messages',
      code: 'VALIDATION_ERROR',
    })
  }

  const m = meta({ values })

  const ref = values.task === undefined ? undefined : required({
    value: values.task as string,
    what: '--task',
  })

  if (!ref && values.action !== undefined) {
    throw new HydraError({
      message: '--action needs --task',
      code: 'VALIDATION_ERROR',
    })
  }

  if (values.kind !== undefined && values.kind !== 'progress') {
    throw new HydraError({
      message: '--kind must be progress',
      code: 'VALIDATION_ERROR',
    })
  }

  const progress = values.kind === 'progress'

  const misused = !ref || !reportActor({ actor: m.actor }) || values.action !== undefined
    || values.text === undefined

  if (progress && misused) {
    throw new HydraError({
      message: '--kind progress is an agent\'s report: pass --task and --text, no --action, and --actor worker:<task> when PNYX_ACTOR is unset',
      code: 'VALIDATION_ERROR',
    })
  }

  const result = commit({
    hydraId,
    meta: m,
    intent: {
      type: 'hydra.message',
      card: ref ?? '$board',
    },
    decide: ({ state }) => {
      const task = ref ? findCard({
        state,
        ref,
      }) : undefined

      if (task && !liveTask({ card: task })) {
        throw new HydraError({
          message: 'choose a task, not an unassigned session',
          code: 'VALIDATION_ERROR',
        })
      }

      const action = String(values.action ?? 'send')

      if (action !== 'send' && action !== 'worker') {
        throw new HydraError({
          message: '--action must be send or worker',
          code: 'VALIDATION_ERROR',
        })
      }

      const text = task
        ? String(values.text ?? `${action === 'worker' ? 'Create a worker for' : 'Work with me on'} task ${task.id}: ${task.title}. Read its task history and current record before continuing.`)
        : required({
          value: values.text as string | undefined,
          what: '--text',
        })
      const context = mentionContext({
        state,
        text,
      })
      const decision = hydraEvent({
        state,
        meta: m,
        cardId: task?.id ?? '$board',
        change: {
          type: 'hydra.message',
          data: {
            ...(task ? { task: task.id } : {}),
            action,
            ...(progress ? { kind: 'progress' as const } : {}),
            text,
            ...(m.details ? { details: m.details } : {}),
            ...(context ? { context } : {}),
            hydra: hydraConfig({
              state,
              id: hydraId,
            }).hydra.id,
          },
        },
      })

      if ('event' in decision) {
        decision.event.messageId = decision.event.id
      }

      return decision
    },
  })

  if (!ref && ownerActor({ actor: m.actor })) {
    nameHydra({
      hydraId,
      meta: m,
      text: String(values.text),
    })
  }

  const config = hydraConfig({
    state: loadHydra({ hydraId }).state,
    id: hydraId,
  })

  if (progress && result.event !== 'none: duplicate') {
    return {
      ...result,
      help: ['Saved on the card without waking Hydra; send questions, blockers and results through task ask or task status'],
    }
  }

  if (config.hydra.kind === 'firstmate' || m.actor === HYDRA_ACTOR || result.event === 'none: duplicate' || !result.message) {
    return result
  }

  const message = loadHydra({ hydraId }).state.hydraMessages
    ?.find(message => message.id === result.message)
  const text = message ? hydraDelivery({ message }) : String(values.text ?? '')

  return readServer({ hydraId }).then(server => server ? askHost({
    hydraId,
    body: {
      action: 'hydra',
      id: String(result.message),
      text,
      actor: m.actor,
    },
  }).then(hosted => ({
    ...result,
    ...hosted,
    help: ['The Pnyx server runs Hydra; replies and startup errors appear in its chat'],
  })) : result)
}

function memoryList({
  memory,
  budget,
  empty,
}: {
  memory: Memory
  budget: number
  empty: string
}): Output {
  const entries = Object.entries(memory).map(([
    key,
    entry,
  ]) => {
    const row: Output = {
      key,
      ...entry,
    }

    if (entry.lines) {
      row.stale = staleLearnings({
        lines: entry.lines,
        now: new Date().toISOString(),
      })
    }

    return row
  })

  return {
    memory: entries.length ? entries : empty,
    used: `${memorySize({ memory })} of ${budget} characters`,
  }
}

function memoryChange({
  action,
  values,
  usage,
}: {
  action: string
  values: Record<string, string | boolean | undefined>
  usage: string
}): {
  key: string
  after: string | null
} {
  const key = required({
    value: values.key as string | undefined,
    what: '--key',
  })

  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key) || ![
    'set',
    'forget',
  ].includes(action)) {
    throw new HydraError({
      message: `${usage}; keys use lowercase letters, digits and dashes`,
      code: 'VALIDATION_ERROR',
    })
  }

  const after = action === 'forget' ? null : required({
    value: values.text as string | undefined,
    what: '--text',
  }).trim()

  if (after !== null && !after) {
    throw new HydraError({
      message: 'memory text must not be empty',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    key,
    after,
  }
}

const hydraCommandHandler = guard({ handler: ({ args }) => hydraCommand({ args }) })

const owner = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
    } = parse({
      args,
      // Owner memory has no events or cards, so it takes only the write flags it honours.
      options: {
        ...COMMON,
        actor: WRITE.actor!,
        reason: WRITE.reason!,
        'if-revision': WRITE['if-revision']!,
        key: { type: 'string' },
        text: { type: 'string' },
      },
      positionals: 2,
    })
    const usage = 'use owner memory list|set|forget|confirm'

    if (positionals[0] !== 'memory') {
      throw new HydraError({
        message: usage,
        code: 'VALIDATION_ERROR',
      })
    }

    const action = positionals[1] ?? 'list'

    if (action === 'list') {
      return {
        ...memoryList({
          memory: ownerMemory(),
          budget: OWNER_MEMORY_BUDGET,
          empty: 'none: no owner memory yet',
        }),
        revision: ownerRevision(),
      }
    }

    if (action === 'confirm') {
      const memory = ownerMemory()
      const line = required({
        value: values.text as string | undefined,
        what: '--text <existing learning line>',
      })
      const entry = saveOwnerMemory({
        key: 'learnings',
        after: memory.learnings?.text ?? null,
        confirmed: line,
        meta: meta({ values }),
      })

      return {
        memory: 'learnings',
        state: 'confirmed',
        revision: entry?.seq,
      }
    }

    const {
      key,
      after,
    } = memoryChange({
      action,
      values,
      usage,
    })
    const entry = saveOwnerMemory({
      key,
      after,
      meta: meta({ values }),
    })

    return entry ? {
      memory: key,
      state: after === null ? 'forgotten' : 'saved',
      revision: entry.seq,
      used: `${memorySize({ memory: ownerMemory() })} of ${OWNER_MEMORY_BUDGET} characters`,
    } : {
      memory: key,
      skipped: 'unchanged',
    }
  },
})

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
  const events = ids.size ? readEvents({ hydraId }).filter((e): e is NotedEvent => e.type === 'card.noted' && ids.has(e.id)) : []
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
    ).map(n => (n.text.length > NOTE_CUT ? {
      ...n,
      text: `${n.text.slice(
        0,
        NOTE_CUT,
      )}…`,
    } : n))

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

const card = guard({
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
    const found = findCard({
      state: loadHydra({ hydraId }).state,
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

    if (cut) {
      help.unshift(`Run \`pnyx-axi card ${found.id} --full\` for every note in full`)
    }

    if (!found.notes?.length) {
      help.push(`Run \`pnyx-axi harvest --card ${found.id}\` to collect its summaries, decisions and context`)
    }

    const asking = found.attention.find(request => answerPrompt({
      card: found,
      request,
    }))

    if (asking) {
      help.unshift(`Run \`pnyx-axi reply ${found.id} --answer ${asking.key} --json <answer>\` to answer its ${asking.kind} (see \`pnyx-axi reply --help\`)`)
    }

    return {
      card: cardDetail({ card: found }),
      notes,
      help,
    }
  },
})

// Collects the notes sources already recorded: the cards' transcripts from where
// the last read stopped, and each linked pull request's title and description.
// ponytail: reads every linked pull request on each run; skip merged ones already noted if hydras grow.
const harvest = guard({
  handler: ({ args }) => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        card: { type: 'string' },
      },
      positionals: 0,
    })
    const { state } = loadHydra({ hydraId })
    const cards = values.card ? [
      findCard({
        state,
        ref: values.card as string,
      }),
    ] : Object.values(state.cards)
    // Read before taking the writer lock: gh-axi can be slow and must not block other writers.
    const prs = cards.flatMap(c => c.links.filter(l => l.kind === 'github_pr').map(l => ({
      card: c.id,
      url: l.url,
      note: pullRequestNote({ url: l.url }),
    })))

    return withWriter({
      hydraId,
      fn: ({ writer }) => {
        const spool = drainSpool({ writer })
        const at = new Date().toISOString()
        let notes = harvestTranscripts({
          writer,
          cardIds: cards.map(c => c.id),
          at,
        })

        for (const pr of prs) {
          if (pr.note) {
            notes += appendNote({
              writer,
              cardId: pr.card,
              note: pr.note,
              at,
            })
          }
        }

        const unread = prs.filter(pr => !pr.note).map(pr => pr.url)
        const out: Output = {
          harvested: {
            cards: cards.length,
            notes: notes ? `${notes} new` : 'none: nothing new',
            pullRequests: prs.length - unread.length,
          },
        }

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
        column: hydraConfig({ state }).columns
          .find(c => c.id === target || c.role === target)?.id ?? target,
        before,
        meta: m,
      }),
    })
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
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options,
      positionals: 1,
    })
    const m = meta({ values })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const url = required({
      value: values.url as string | undefined,
      what: '--url',
    })
    const s = ({ name }: { name: string }) => values[name] as string | undefined
    const parsed = values.remove
      ? null
      : parseLink({
        input: {
          url,
          kind: s({ name: 'kind' }),
          number: s({ name: 'number' }),
          title: s({ name: 'title' }),
          state: s({ name: 'state' }),
          checkedAt: s({ name: 'state' }) && new Date().toISOString(),
        },
      })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.linked',
        card: ref,
      },
      decide: ({ state }) => decideLink({
        state,
        ref,
        url,
        link: parsed,
        meta: m,
      }),
    })
  },
})

const outcome = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: {
        ...WRITE,
        note: { type: 'string' },
        clear: { type: 'boolean' },
      },
      positionals: 2,
    })
    const m = meta({ values })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const state = positionals[1]

    if (Boolean(values.clear) === (state !== undefined)) {
      throw new AxiError(
        'give either an outcome or --clear',
        'VALIDATION_ERROR',
        [`Outcomes: ${OUTCOME_STATES.join(', ')}`],
      )
    }

    if (state !== undefined && !(OUTCOME_STATES as readonly string[]).includes(state)) {
      throw new AxiError(
        `unknown outcome: ${state}`,
        'VALIDATION_ERROR',
        [`Use one of ${OUTCOME_STATES.join(', ')}`],
      )
    }

    const note = values.note as string | undefined
    const result = state === undefined
      ? null
      : {
        state: state as OutcomeState,
        ...(note ? { note } : {}),
      }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.outcome',
        card: ref,
      },
      decide: ({ state: s }) => decideOutcome({
        state: s,
        ref,
        outcome: result,
        meta: m,
      }),
    })
  },
})

export function summarize({ event }: { event: HydraEvent }): string {
  const text = summary({ event })

  return event.reason ? `${text} (why: ${event.reason})` : text
}

function landingWording({ rule }: { rule: LandingRule }): string {
  if (rule.landing === 'branch') {
    return 'a branch'
  }

  return `a pull request merged by ${rule.merge}`
}

function summary({ event }: { event: HydraEvent }): string {
  const undo = event.undoes ? `undo ${event.undoes}: ` : ''

  switch (event.type) {
    case 'chat.message': return `${event.data.role}: ${event.data.text}`
    case 'board.configured': return `Hydra ${event.data.name}; Hydra ${event.data.hydra.id}`
    case 'board.columns': return `Columns: ${event.data.columns.map(c => c.title).join(', ')}`
    case 'hydra.project': return `${event.data.before && event.data.before.detached === event.data.after.detached ? 'Updated' : event.data.after.detached ? 'Detached' : 'Attached'} project ${event.data.after.name}: ${event.data.after.path}${event.data.sharedWith.length ? `; shared with Hydra ${event.data.sharedWith.map(h => h.name).join(', ')}` : ''}`
    case 'task.project': return `Task project: ${event.data.after ?? 'none'}`
    case 'task.kind': return event.data.after === 'build' ? 'Investigation turned into the build' : `Task kind: ${event.data.after}`
    case 'task.report': return `Report stored (${event.data.text.length} characters)`
    case 'task.landing': return event.data.after
      ? `For this task only: lands as ${landingWording({ rule: event.data.after })}`
      : 'Follows its project\'s landing rule again'
    case 'task.copy': return `Task copy ${event.data.after.state}: ${event.data.after.path}${event.data.after.reason ? ` (${event.data.after.reason})` : ''}`
    case 'task.created': return `Created ${event.data.parentId ? 'subtask' : 'task'}: ${event.data.title}`
    case 'task.permission': return `${event.data.tool} permission ${event.data.id}: ${event.data.status}`
    case 'task.reminder': return event.data.after ? `Reminder set for ${event.data.after}` : 'Reminder cleared'
    case 'task.reminder-due': return event.data.message.text
    case 'task.intent': return 'Owner ask added'
    case 'task.brief': return 'Task brief updated'
    case 'task.retention': return event.data.after === null ? 'Using the Hydra hide time' : event.data.after === 0 ? 'Keeping the Done card visible' : `Done card hidden after ${event.data.after} hours`
    case 'task.visibility': return event.data.after ? 'Task hidden from Hydra' : 'Task returned to Hydra'
    case 'hydra.memory': return `${event.data.after === null ? 'Forgot' : 'Saved'} Hydra memory: ${event.data.key}`
    case 'task.declared': return `${declaredState({ declaration: event.data })}: ${event.data.note}`
    case 'task.asked': return `Asked ${event.data.audience === 'owner' ? 'the owner' : 'Hydra'} (${event.data.id}): ${event.data.question}`
    case 'task.ask.escalated': return `Escalated ${event.data.ask} to the owner${event.data.question ? `: ${event.data.question}` : ''}`
    case 'task.launched': return `Started through ${event.data.via} in ${event.data.folder ?? 'unknown folder'}`
    case 'task.mirrored': return `Mirrored Firstmate task ${event.data.task}`
    case 'hydra.dispatch-proposed': return `Proposed dispatch change: ${event.data.summary}`
    case 'hydra.dispatch-progress': return `Owner question ${event.data.status}${event.data.error ? `: ${event.data.error}` : ''}`
    case 'hydra.dispatch-resolved': return `Dispatch proposal ${event.data.action}`
    case 'hydra.message': return `${event.actor === HYDRA_ACTOR ? 'Hydra' : event.data.action === 'worker' ? 'Create a worker' : event.data.kind === 'progress' ? 'Progress' : 'Send to Hydra'}: ${event.data.text}${event.data.details ? ` (${event.data.details})` : ''}`
    case 'hydra.status': return `Hydra ${event.data.state} since ${event.data.since}${event.data.detail ? `: ${event.data.detail}` : ''}`
    case 'board.agents': return `Legacy agents: ${Object.keys(event.data.agents).join(', ') || 'none'}`
    case 'task.queue': return event.data.after ? `queued for ${event.data.after.session}` : `unqueued${event.data.note ? `: ${event.data.note}` : ''}`
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
      const facts = [
        event.data.after?.checks === undefined ? '' : ` · checks ${event.data.after.checks}`,
        event.data.after?.comments === undefined ? '' : ` · ${event.data.after.comments} comments`,
      ].join('')

      return `${undo}${event.data.after ? `${label} ${event.data.after.state ?? 'unknown'}${facts}` : `removed ${label}`}`
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
      updates: { type: 'boolean' },
    }
    const {
      values,
      hydraId,
    } = parse({
      args,
      options,
      positionals: 0,
    })
    const limit = Math.min(
      integer({
        value: values.limit,
        flag: '--limit',
      }) ?? HISTORY_LIMIT,
      HISTORY_MAX,
    )
    const before = integer({
      value: values.before,
      flag: '--before',
    })
    const kind = values.kind as string | undefined
    const type = kind && (kind.includes('.') ? kind : `card.${kind}`)

    if (type && !(EVENT_TYPES as readonly string[]).includes(type)) {
      throw new AxiError(
        `unknown kind: ${kind}`,
        'VALIDATION_ERROR',
        ['Use one of pushed, moved, linked, outcome, replied, noted'],
      )
    }

    const { state } = loadHydra({ hydraId })
    const cardId = values.card ? findCard({
      state,
      ref: values.card as string,
    }).id : undefined
    const workspace = values.workspace as string | undefined
    // An outcome keeps the workspace it was recorded under; other events use the card's current one.
    const inWorkspace = ({ e }: { e: HydraEvent }) =>
      (e.type === 'card.outcome' ? e.data.card.workspace : state.cards[e.cardId]?.workspace) === workspace

    const tagged = new Set(cardId ? [cardId] : [])
    const matches = readEvents({ hydraId })
      .filter(e => (before === undefined || e.seq < before)
        && (!cardId || e.cardId === cardId || tagsTask({
          event: e,
          ids: tagged,
        })))
      .filter(e => (!type || e.type === type) && (!workspace || inWorkspace({ e }))
        && (!values.updates || showsUpdate({ event: e })))
      .reverse()
    const page = matches.slice(
      0,
      limit,
    )

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
        ...(values.full ? {
          data: e.data,
          reason: e.reason,
          details: e.details,
        } : {}),
      })),
    }

    if (matches.length > limit) {
      const flags = [
        'card',
        'kind',
        'workspace',
        'limit',
        'hydra',
      ].flatMap(f => (values[f] ? [
        `--${f}`,
        String(values[f]),
      ] : []))
      out.help = [
        `Run \`pnyx-axi history ${[
          ...flags,
          ...values.updates ? ['--updates'] : [],
          '--before',
          String(page.at(-1)!.seq),
        ].join(' ')}\` for older events`,
      ]
    }

    return out
  },
})

const undo = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: WRITE,
      positionals: 1,
    })
    const m = meta({ values })
    const id = required({
      value: positionals[0],
      what: 'event id',
    })
    const target = readEvents({ hydraId }).find(e => e.id === id)

    if (!target) {
      throw new AxiError(
        `event not found: ${id}`,
        'NOT_FOUND',
        ['Run `pnyx-axi history` to find event ids'],
      )
    }

    return commit(
      {
        hydraId,
        meta: m,
        intent: {
          type: target.type,
          card: target.cardId,
        },
        decide: ({
          state,
          meta: current,
        }) => decideUndo({
          state,
          target,
          meta: current,
        }),
      },
    )
  },
})

const repair = guard({
  handler: ({ args }) => {
    const { hydraId } = parse({
      args,
      options: COMMON,
      positionals: 0,
    })
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
    const options: Options = {
      ...WRITE,
      harness: { type: 'string' },
      remove: { type: 'boolean' },
      preview: { type: 'boolean' },
      'allow-custom-home': { type: 'boolean' },
      home: { type: 'string' },
      port: { type: 'string' },
    }
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options,
      positionals: 1,
    })

    if (positionals[0] === 'check') {
      return setupCheckOutput({ hydraId })
    }

    if ([
      'hooks',
      'service',
      'skills',
    ].includes(positionals[0] ?? '')) {
      requireSetupHome({ allowCustomHome: !!values['allow-custom-home'] })
    }

    if (positionals[0] === 'skills') {
      return setupSkills({
        remove: !!values.remove,
        preview: !!values.preview,
      })
    }

    if (positionals[0] === 'service') {
      if (values.home !== undefined || args.some(a => a === '--hydra' || a.startsWith('--hydra='))) {
        throw new AxiError(
          'setup service runs every Hydra; it takes no --hydra or --home',
          'VALIDATION_ERROR',
          ['Run `pnyx-axi setup hydra --home <firstmate home> --hydra <id>` to link a Firstmate home to its Hydra'],
        )
      }

      return setupService({
        port: integer({
          value: values.port,
          flag: '--port',
        }),
        remove: !!values.remove,
        preview: !!values.preview,
      })
    }

    if (positionals[0] === 'hydra') {
      return setupHydra({
        hydraId,
        home: required({
          value: values.home as string | undefined,
          what: '--home',
        }),
        meta: meta({ values }),
      })
    }

    if (positionals[0] !== 'hooks') {
      throw new AxiError(
        `unknown setup target: ${positionals[0] ?? '(none)'}`,
        'VALIDATION_ERROR',
        ['Run `pnyx-axi setup check`, `pnyx-axi setup skills`, `pnyx-axi setup hooks` or `pnyx-axi setup hydra --home <firstmate home>`'],
      )
    }

    const harness = values.harness as string | undefined

    if (harness !== undefined && !(HARNESSES as readonly string[]).includes(harness)) {
      throw new AxiError(
        `unknown harness: ${harness}`,
        'VALIDATION_ERROR',
        [`Use one of ${HARNESSES.join(', ')}`],
      )
    }

    const targets = harness ? [harness as Harness] : detectedHarnesses()

    if (targets.length === 0) {
      throw new AxiError(
        'no Claude Code or Codex config folder found',
        'NOT_FOUND',
        ['Run `pnyx-axi setup hooks --harness claude|codex`'],
      )
    }

    const remove = Boolean(values.remove)
    const preview = Boolean(values.preview)
    const hooks = targets.map(h => setupHooks({
      harness: h,
      opts: {
        remove,
        preview,
      },
    }))
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
    const [
      sub,
      ...rest
    ] = args
    const {
      values,
      hydraId,
    } = parse({
      args: rest,
      options: {
        ...WRITE,
        json: { type: 'string' },
      },
      positionals: 0,
    })

    if (sub === 'show') {
      const { state } = loadHydra({ hydraId })

      return {
        view: viewFor({ state }),
        revision: state.viewRevision ?? 0,
      }
    }

    if (sub === 'schema') {
      return {
        defaults: DEFAULT_VIEW,
        help: ['view set --json <patch> --if-revision <revision>'],
      }
    }

    if (sub !== 'set') {
      throw new AxiError(
        'use view show, schema or set',
        'VALIDATION_ERROR',
      )
    }

    let patch: unknown

    try {
      patch = JSON.parse(required({
        value: values.json as string,
        what: '--json',
      }))
    } catch {
      throw new AxiError(
        '--json must contain a preference object',
        'VALIDATION_ERROR',
      )
    }

    const m = meta({ values })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state: s }) => decideView({
        state: s,
        patch,
        meta: m,
      }),
    })
  },
})

const layout = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: WRITE,
      positionals: 1,
    })

    if (positionals[0] === 'show') {
      const view = viewFor({ state: loadHydra({ hydraId }).state })

      return {
        widths: {
          hydra: view.hydraWidth,
          columns: view.columnWidths,
        },
        defaults: {
          column: DEFAULT_WIDTHS.column,
          hydra: view.defaultHydraWidth,
          columns: view.defaultColumnWidths,
        },
      }
    }

    if (positionals[0] !== 'reset') {
      throw new HydraError({
        message: 'use layout show or reset',
        code: 'VALIDATION_ERROR',
      })
    }

    const m = meta({ values })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state }) => decideView({
        state,
        patch: resetLayoutWidths({ view: viewFor({ state }) }),
        meta: m,
      }),
    })
  },
})

export const commands = {
  layout,
  column: columnCommandHandler,
  hydra: hydraCommandHandler,
  owner,
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
  hydra create|list|homes|show|set|memory     Configure Hydras and their own notes; owner memory list|set|forget keeps the owner's for every Hydra
  project add|list|set|remove                   Attach, list or detach projects
  column create|rename|describe|resize|delete|reorder|list  Edit columns
  task create|list|show|rename|status|history|permission Tasks and one level of subtasks (--parent <id>)
  task start|continue <task>                  Start a worker or host an ended outside session
  hydra start|send|messages|check            Start the Hydra, queue task context in its chat, read it, or wait for changes
  rule; account list|set|remove              Heads dispatch rules and worker login folders
  task sessions|queue|unqueue|reorder        Sessions and ordered worker queues
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
  setup check|skills|hooks|service          List what setup still needs, or install global skills, reporting hooks or the macOS login service
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
pnyx-axi hydra send --task <id> --kind progress --text <message>
--kind progress is a worker's routine progress: it updates the task's card and joins Hydra's next wake without waking Hydra.
pnyx-axi hydra stop
hydra stop ends the turn Pnyx's hosted Hydra is running; its workers keep going.
pnyx-axi hydra usage
hydra usage prints the hosted Hydra's context window use and session cost when known, and its account's plan windows from quota-axi.
pnyx-axi hydra resize --width <pixels>
pnyx-axi hydra worker-notes set|forget [--text <text>] --reason <why>
Standing worker instructions are included verbatim in every new worker header.
pnyx-axi hydra memory list|set|forget [--key <key>] [--text <text>]
Hydra memory holds only what this Hydra needs (its scope, where it left off, its check cursor), within ${HYDRA_MEMORY_BUDGET} characters. Owner preferences and learnings are Pnyx-wide: see \`pnyx-axi owner --help\`.
pnyx-axi hydra digest
Prints Hydra's live state: columns, open tasks and their workers, what waits on someone, owner memory and Hydra memory.
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
  owner: `usage: pnyx-axi owner memory list|set|forget|confirm [--key <key>] [--text <text>] [--reason <why>] [--if-revision <n>]
Owner memory is Pnyx-wide: every Hydra's digest prints it. Keep the owner's preferences under the key preferences and general learnings under learnings,
one line per entry, and save each document whole. It holds ${OWNER_MEMORY_BUDGET} characters; a save over budget is refused.
Pass the revision list printed as --if-revision so a save made from an older read is refused instead of replacing another Hydra's save.
Every replacement and removal stays in $PNYX_HOME/owner/memory.jsonl (default ~/.pnyx).
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
pnyx-axi task create --title <title> [--project <name>] [--ask <text>] [--message <owner-message-id>] [--brief <text>] [--kind build|investigation] [--key <key>] [--folder <path>] [--column <id>] [--parent <task>] [--reason <text>] [--details <text>]
pnyx-axi task intent <id> --text <owner-words> [--message <owner-message-id>]
pnyx-axi task brief <id> --brief <text> [--reason <text>] [--details <text>]
pnyx-axi task hide|unhide <id> [--reason <text>] [--details <text>]
pnyx-axi task list | show <id> [--full]
pnyx-axi task rename <id> [--title <title>] [--project <name>]
--project adds a compact project label; an empty value clears it.
pnyx-axi task status <id> working|needs_you|paused|blocked|done [--note <text>] [--until <time> | --hold]
A paused worker's --until (ISO time, "in 2 hours" or "tomorrow 9:00") ends its wait: Hydra is woken once then.
--hold marks a pause the owner or Hydra asked for: it waits for their word and never wakes Hydra on a timer. A pause with neither wakes Hydra after 4 hours.
done is refused while the task's work has not landed by its project's rule (uncommitted files, or a pull request not yet merged),
or, for an investigation, before its report is stored. The owner can still move the card to Done.
pnyx-axi task report <id> [--file <path>]
Stores an investigation's report with the task (every version stays in the log), or prints the latest one.
pnyx-axi task build <id>
Turns an investigation with a stored report into its build; its worker keeps the context and starts a fresh branch. Owner, or Hydra on the owner's word.
pnyx-axi task landing <id> [--landing pr|branch] [--merge owner|hydra] [--clear]
Gives this task alone a landing rule other than its project's, or prints the rule it follows. Owner, or Hydra on the owner's word.
pnyx-axi task merge <id> [--url <pull request>]
Merges the task's linked pull request with a merge commit and records it. Hydra may merge only where the project's rule is --merge hydra,
and never while a check is red or still running.
pnyx-axi task ask <task> --question <text> [--context <text>] [--choice "<label>[: <description>]"]... [--recommend <n>] [--details <text> | --details-file <path>] [--to hydra|owner]
A worker's question goes to Hydra (the default); only Hydra asks the owner, with --to owner. Choices are optional: a typed answer is always accepted.
pnyx-axi task answer <task> <question> [--choice <n|label>] [--text <answer>] [--from-message <id>] [--reason <text>] [--undelivered]
Sends the answer to the task's worker and resolves the question once it is delivered. Hydra answers questions asked of it, or records an owner answer with --from-message <id>, quoting an owner message newer than the question.
An answer still being sent or of unknown delivery holds the question; after checking that it never arrived, --undelivered answers (or escalates) again.
pnyx-axi task escalate <task> <question> [--question <owner-facing text>] [--context <text>] [--undelivered] --reason <text>
Hydra hands a worker's question to the owner under the same id; the worker's wording stays in its history.
pnyx-axi task history <id> [--before <seq>] [--limit <n>] [--full]
pnyx-axi task chat <id> [--session <past-or-current-session>] [--before <cursor>]
pnyx-axi task permission <task> <request> allow|deny [--answer <json>] [--reason <text>]
A question request is allowed with its answers, --answer '{"answers":[{"pick":[1]},{"text":"..."}]}' (one per question, picks
numbered from 1), and a form with --answer '{"values":{"<field>":"<value>"}}'; deny skips it.
pnyx-axi task project <task> --project <name|path>
pnyx-axi task remind <task> <when|clear>
pnyx-axi task reminders
pnyx-axi task continue <task> [--check]
pnyx-axi task start <task> [--via pnyx|paseo] [--rule <name>] [--harness claude|codex] [--model <model>] [--effort <effort>] [--mode <mode>] [--fast on|off] [--prompt <text>] [--folder <path>] [--in-place] [--paseo-url <url>] [--replace-session <session>]
pnyx-axi task start <task> --via firstmate [--prompt <text>]
pnyx-axi task start <task> --via command [--command <project-command-name>] [--prompt <text>] [--harness <name>] [--folder <path>] [--in-place]
pnyx-axi task copy <task> [remove [--safe | --discard]]
Hydra (actor hydra) must pass --reason, one short why, to create, brief, hide, unhide, start and permission, as to move. Pnyx keeps it on the event,
and shows the changes in the task’s Updates and the turn’s fold. --details keeps longer context on the same event.
pnyx-axi task paseo [--paseo-url <url>]
pnyx-axi task queue <task> --behind <task|session>
pnyx-axi task unqueue <task>
pnyx-axi task reorder <task> --behind <task|session>
pnyx-axi task sessions
pnyx-axi task attach <task> --session <session-id|card-id|key|self>
pnyx-axi task detach <task>
Queueing behind a session appends; behind a queued task inserts immediately after it. Repeating task queue or using task reorder changes that position. Unqueue releases a task for a separate worker. Only unstarted tasks in the same project can queue. The server advances after a merged PR or a declared done task whose commit landed, never an open PR.
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
running when the server stopped is marked interrupted and waits for a message. Permission prompts and
questions wait on the task for task permission. Codex mode is its approval policy (untrusted, on-request or
never) with its sandbox: never, or bypassPermissions, runs with full access, the others write only in the folder and Pnyx's home. Codex applies picker changes on the next turn and queues messages during a turn.
--via paseo asks the local Paseo daemon (PNYX_PASEO_URL, default ws://127.0.0.1:6767/ws) to start a
Claude Code or Codex agent instead, then attaches it; replies and the conversation go through Paseo,
and the agent stays in Paseo too. task paseo checks the daemon. --folder also records the task's folder.
Repeating the same --event-id never starts a second agent.
--rule chooses the heads dispatch candidate list (default: default); an explicit owner --harness or
--model wins outside that list, checked against its own catalog and login. --prompt sets its opening message, which otherwise names the task and the pnyx-worker skill. Known quota ranks
by spendPriority above unknown quota; a tie, or several candidates with unknown quota, stops the start.
--model, --effort, --mode and --fast on|off replace the chosen candidate's settings from the first turn; the model
must be in the harness's catalog and the task records the override.
--via firstmate puts a worker request in Hydra's chat and sends it to the Hydra's Firstmate home as an inbox note.
--via command --command <name> selects the assigned project’s named command (project list); without --command it runs the configured Hydra command. It runs in the task's folder with PNYX_TASK and the rest of its context in the
environment; the session it starts attaches to the task when its hooks first report.
The default route is firstmate for a Hydra run by a Firstmate home, otherwise pnyx.
A task with an attached project starts in its own copy: a git worktree slot copies/<project>-<n> on branch
pnyx/<hydra>-<task> (or the project's copy command, see project set), taken once and reused by later starts. A start
takes a clean idle slot from the project's pool when there is one, keeping its ignored files such as installed
dependencies, and starts the branch from the fetched origin default branch. A failed refresh stops allocation;
projects without origin use local HEAD. --in-place works in the project folder
itself and is refused while a worker of another Hydra runs there; --folder names the folder outright. Firstmate Hydras
make their own copies.
When the task reaches Done and its agent stops working, Pnyx releases its copy if it has no uncommitted changes and its
commit is on the default branch or its linked pull request merged; the branch stays. Copies from a project's copy
command are only released. Otherwise the task keeps the copy, flagged, and Hydra gets a message.
A released slot goes back to the pool when fewer than ${POOL_IDLE} clean idle slots of the project are already there, or
when an attached worker still runs in it; otherwise it is deleted. A slot a worker runs in is never handed to another task.
Queued handoff prepares the next branch and transfers the folder; manual task attach only moves the session.
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
Hydra's moves need --reason, kept on the event and shown in the task's Updates. The owner's moves need none.
`,
  link: `usage: pnyx-axi link <id> --url <url> [--kind github_pr|linear|url] [--number <n>] [--title <text>] [--state open|merged|closed] [--remove] [--event-id <id>] [--if-revision <n>]
GitHub pull request URLs get kind and number filled in. A link never moves the card.
`,
  outcome: `usage: pnyx-axi outcome <id> done|failed|cancelled [--note <text>] | --clear [--event-id <id>] [--if-revision <n>]
`,
  history: `usage: pnyx-axi history [--card <id>] [--kind pushed|moved|linked|outcome|replied|noted] [--workspace <name>] [--before <seq>] [--limit <n>] [--full] [--updates]
Newest first, ${HISTORY_LIMIT} per page (max ${HISTORY_MAX}). --updates keeps only the events a task's Updates list shows.
`,
  undo: `usage: pnyx-axi undo <event-id> [--event-id <id>] [--if-revision <n>]
Appends an event that reverses a manual push edit, move, link or outcome. Refused when the card changed since.
Source observations, card creation and merges cannot be undone.
`,
  setup: `usage: pnyx-axi setup check [--hydra <id>]
pnyx-axi setup service [--port <n>] [--remove] [--preview] [--allow-custom-home]
pnyx-axi setup hooks [--harness claude|codex] [--remove] [--preview] [--allow-custom-home]
pnyx-axi setup skills [--remove] [--preview] [--allow-custom-home]
pnyx-axi setup hydra --home <firstmate home> [--hydra <id>]
setup check lists what is still missing (local config, logins, hooks, skills, quota-axi, the login service,
project profiles) and who fixes each; it exits 1 while anything is missing. A Hydra's digest lists the same.
setup hooks, service and skills refuse a non-default PNYX_HOME unless --allow-custom-home is given.
setup service refuses a port reserved by another Pnyx home; choose a different --port.
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
