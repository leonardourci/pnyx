import { columnRule } from '../core/columns.ts'
import { workerNotesNotice } from '../memory/workers.ts'
import { createHash } from 'node:crypto'
import { hydraConfig } from '../core/hydra.ts'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { AxiError } from 'axi-sdk-js'
import {
  type Decision,
  type Meta,
} from '../core/decide.ts'
import {
  HydraError,
  HYDRA_ACTOR,
  type HydraEvent,
  type HydraState,
  type EventType,
} from '../core/model.ts'
import { emptyHydra, replay } from '../core/reducer.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { withWriter, type Writer } from './writer.ts'
import { DEFAULT_HYDRA } from './home-migration.ts'
import { readEvents } from './event-log.ts'
import { summarize } from './cli.ts'

export const HISTORY_LIMIT = 20

export const HISTORY_MAX = 100

export const HOME_LIMIT = 50

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
