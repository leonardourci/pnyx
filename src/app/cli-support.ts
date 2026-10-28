import { parseArgs, type ParseArgsConfig } from 'node:util'
import { createHash } from 'node:crypto'
import { AxiError } from 'axi-sdk-js'
import type { EventType, HydraState, HydraEvent, Decision } from './model.ts'
import { helpFlags } from '../cli/help.ts'
import { DEFAULT_HYDRA } from './home-migration.ts'
import type { Meta } from './command-meta.ts'
import { HYDRA_ACTOR } from './actors.ts'
import { HydraError } from '../core/model.ts'
import { hydraConfig, declaredState } from '../core/hydra.ts'
import { columnRule } from '../core/columns.ts'
import { readEvents } from './event-log.ts'
import { replay, emptyHydra } from './reducer.ts'
import { withWriter, type Writer } from './writer.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { workerNotesNotice } from '../memory/workers.ts'
import { harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { landingWording } from '../tasks/delivery/cli.ts'

export const HISTORY_LIMIT = 20

export const HISTORY_MAX = 100

export const HOME_LIMIT = 50

export const TEXT_CUT = 1000

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

// The running CLI command (`task create`) and its focused help, set by the CLI entry, so usage
// errors can point at that subcommand. Commands run inside the server leave it empty.
export const invocation: {
  name?: string
  help?: string
} = {}

export function helpHint(): string {
  return invocation.name ? `Run \`pnyx-axi ${invocation.name} --help\`` : 'Run the command with --help'
}

// Translates a node:util parseArgs error. An unknown flag is named, with the valid flags inline.
export function flagError({
  error,
  options,
}: {
  error: unknown
  options: Options
}): AxiError {
  const message = (error as Error).message

  if ((error as { code?: string }).code !== 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return new AxiError(
      message,
      'VALIDATION_ERROR',
      [helpHint()],
    )
  }

  // The subcommand's documented flags plus the global ones it accepts.
  const flags = invocation.help
    ? [
      ...new Set([
        ...helpFlags({ help: invocation.help }),
        ...[
          'hydra',
          'event-id',
          'if-revision',
        ].filter(name => name in options).map(name => `--${name}`),
      ]),
    ]
    : Object.keys(options).map(name => `--${name}`)

  return new AxiError(
    `unknown flag ${/'([^']+)'/.exec(message)?.[1] ?? message}${invocation.name ? ` for \`${invocation.name}\`` : ''}`,
    'VALIDATION_ERROR',
    [`Valid flags: ${flags.filter(flag => flag !== '--help').join(', ')} (--help always allowed)`],
  )
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
    throw flagError({
      error,
      options,
    })
  }

  if (parsed.positionals.length > positionals) {
    throw new AxiError(
      `unexpected argument: ${parsed.positionals[positionals]}`,
      'VALIDATION_ERROR',
      [helpHint()],
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
      [helpHint()],
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
      rules: columns.map(column => ({
        id: column.id,
        rule: columnRule({ column }),
      })),
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

// A long text cut for a default view, with its full length so the reader knows what --full adds.
export function clip({
  text,
  limit = TEXT_CUT,
}: {
  text: string
  limit?: number
}): string {
  return text.length > limit ? `${text.slice(
    0,
    limit,
  )}… (truncated, ${text.length} chars total)` : text
}

// Adds next steps to a write's receipt; a no-op receipt keeps none.
export function withHelp({
  output,
  help,
}: {
  output: Output
  help: ({ output }: { output: Output }) => string[]
}): Output {
  return output.card ? {
    ...output,
    help: help({ output }),
  } : output
}

export function summary({ event }: { event: HydraEvent }): string {
  const undo = event.undoes ? `undo ${event.undoes}: ` : ''

  switch (event.type) {
    case 'session.compaction': return event.data.kind === 'status' ? `Compaction ${event.data.operation.state}${event.data.operation.error ? `: ${event.data.operation.error}` : ''}` : `Compaction ${event.data.kind}`
    case 'pnyx.upgrade': return `Upgrade ${event.data.state}${event.data.error ? `: ${event.data.error}` : ''}`
    case 'task.source.registered': return `External source ${event.data.source.id} registered`
    case 'task.source.lavish.published': return `Lavish source ${event.data.source} reply ${event.data.reply} accepted`
    case 'task.source.started': return `External source ${event.data.source} run started`
    case 'task.source.result': return `External source ${event.data.source} result ${event.data.result.sequence}: ${event.data.result.outcome}`
    case 'task.source.alerted': return event.data.detail
    case 'task.source.handled': return `External source ${event.data.source} result ${event.data.sequence} handled`
    case 'project.refreshed': return `Project copy ${event.data.state}: ${event.data.path}${event.data.reason ? ` (${event.data.reason})` : ''}`
    case 'task.steering.recovery': return `Steering ${event.data.message} recovery: ${event.data.recovery.result}${event.data.recovery.detail ? `: ${event.data.recovery.detail}` : ''}`
    case 'task.steering.queued': return `Steering ${event.data.message.order} queued: ${event.data.message.id}`
    case 'task.steering.notified': return `Steering ${event.data.message} notification: ${event.data.attempt.result}`
    case 'task.steering.handled': return `Steering ${event.data.message} handled: ${event.data.ack.outcome}`
    case 'chat.message': return `${event.data.role}: ${event.data.text}`
    case 'board.configured': return `Hydra ${event.data.name}; Hydra ${event.data.hydra.id}`
    case 'board.columns': return `Columns: ${event.data.columns.map(c => c.title).join(', ')}`
    case 'hydra.project': return `${event.data.before && event.data.before.detached === event.data.after.detached ? 'Updated' : event.data.after.detached ? 'Detached' : 'Attached'} project ${event.data.after.name}: ${event.data.after.path}${event.data.sharedWith.length ? `; shared with Hydra ${event.data.sharedWith.map(h => h.name).join(', ')}` : ''}`
    case 'task.project': return `Task project: ${event.data.after ?? 'none'}`
    case 'task.kind': return event.data.after === 'build' ? 'Investigation turned into the build' : `Task kind: ${event.data.after}`
    case 'task.report-reviewed': return `Report decisions reviewed (${event.data.calls.length} calls)`
    case 'task.report': return `Report stored (${event.data.text.length} characters)`
    case 'task.landing': return event.data.after
      ? `For this task only: lands as ${landingWording({ rule: event.data.after })}`
      : 'Follows its project\'s landing rule again'
    case 'task.copy': return `Task copy ${event.data.after.state}: ${event.data.after.path}${event.data.after.reason ? ` (${event.data.after.reason})` : ''}`
    case 'task.created': return `Created ${event.data.parentId ? 'subtask' : 'task'}: ${event.data.title}`
    case 'task.permission': return `${event.data.tool} permission ${event.data.id}: ${event.data.status}`
    case 'task.reminder': return event.data.after ? `Reminder set for ${event.data.after}` : 'Reminder cleared'
    case 'task.reminder-due': return event.data.message.text
    case 'task.held': return `Held for discussion: ${event.data.reason}`
    case 'task.released': return `Released on owner message ${event.data.message.id}`
    case 'task.intent': return 'Owner ask added'
    case 'task.brief': return 'Task brief updated'
    case 'task.retention': return event.data.after === null ? 'Using the Hydra hide time' : event.data.after === 0 ? 'Keeping the Done card visible' : `Done card hidden after ${event.data.after} hours`
    case 'task.visibility': return event.data.after ? 'Task hidden from Hydra' : 'Task returned to Hydra'
    case 'hydra.helper-started': return 'Routine helper started'
    case 'hydra.helper-finished': return event.data.error ? `Helper handed back: ${event.data.error}` : 'Routine helper outcomes recorded'
    case 'hydra.helper-acknowledged': return 'Helper outcomes handled by Hydra'
    case 'hydra.review': return 'Timed review'
    case 'hydra.memory': return `${event.data.after === null ? 'Forgot' : 'Saved'} Hydra memory: ${event.data.key}`
    case 'task.declared': return `${declaredState({ declaration: event.data })}: ${event.data.note}`
    case 'task.asked': return `Asked ${event.data.audience === 'owner' ? 'the owner' : 'Hydra'} (${event.data.id}): ${event.data.question}`
    case 'task.ask.closed': return `Closed ${event.data.ask}: ${event.data.reason} (${event.data.evidence})`
    case 'task.ask.reopened': return `Reopened ${event.data.ask}`
    case 'task.ask.escalated': return `Escalated ${event.data.ask} to the owner${event.data.question ? `: ${event.data.question}` : ''}`
    case 'task.launched': return `Started through ${event.data.via} in ${event.data.folder ?? 'unknown folder'}`
    case 'task.mirrored': return `Mirrored Firstmate task ${event.data.task}`
    case 'hydra.dispatch-proposed': return `Proposed dispatch change: ${event.data.summary}`
    case 'hydra.dispatch-progress': return `Owner question ${event.data.status}${event.data.error ? `: ${event.data.error}` : ''}`
    case 'hydra.dispatch-resolved': return `Dispatch proposal ${event.data.action}`
    case 'hydra.message': return `${event.actor === HYDRA_ACTOR ? 'Hydra' : event.data.action === 'worker' ? 'Create a worker' : event.data.kind === 'progress' ? 'Progress' : 'Send to Hydra'}: ${event.data.text}${event.data.details ? ` (${event.data.details})` : ''}`
    case 'hydra.status': return `Hydra ${event.data.state} since ${event.data.since}${event.data.detail ? `: ${event.data.detail}` : ''}`
    case 'board.agents': return `Legacy agents: ${Object.keys(event.data.agents).join(', ') || 'none'}`
    case 'task.dependencies': return `Prerequisites: ${event.data.after.join(', ') || 'none'}`
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

export function summarize({ event }: { event: HydraEvent }): string {
  const text = summary({ event })

  return event.reason ? `${text} (why: ${event.reason})` : text
}
