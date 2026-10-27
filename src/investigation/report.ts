import { isDeepStrictEqual } from 'node:util'
import { reportCalls, requireReportReview } from './inventory.ts'
import { requireReady } from '../core/dependencies.ts'
import { requireUnheld } from '../core/holds.ts'
import { readFileSync } from 'node:fs'
import { findCard, type Meta } from '../core/decide.ts'
import { hydraEvent, reportActor } from '../core/hydra.ts'
import { HydraError, TASK_KINDS, type Card, type HydraState, type TaskKind, type ReportCall } from '../core/model.ts'
import { readEvents } from '../app/event-log.ts'

// Big enough for a long written investigation, small enough to keep each log line readable.
export const REPORT_MAX_CHARS = 100_000

export function investigationLine({
  hydraId,
  id,
}: {
  hydraId: string
  id: string
}): string {
  return `Investigation: answer the brief with a report that stands alone (what was asked, what you found, the evidence, and what you recommend). Store it with \`pnyx-axi task report ${id} --file <path> --hydra ${hydraId}\`, review the whole report for owner choices with \`pnyx-axi task report-review ${id} --report <report-id> --none --hydra ${hydraId}\` or \`--call <task>/<ask>\` for every durable owner question on a separate gated task, then declare done. A report does not authorize building: change nothing beyond what the investigation needs, and leave nothing in your copy that the report depends on.`
}

export function reportLine({
  hydraId,
  id,
}: {
  hydraId: string
  id: string
}): string {
  return `This task began as an investigation; read its stored report with \`pnyx-axi task report ${id} --hydra ${hydraId}\` before building.`
}

export function parseKind({ value }: { value: string }): TaskKind {
  if (!(TASK_KINDS as readonly string[]).includes(value)) {
    throw new HydraError({
      message: `--kind must be ${TASK_KINDS.join(' or ')}`,
      code: 'VALIDATION_ERROR',
    })
  }

  return value as TaskKind
}

export function readReportFile({ path }: { path: string }): string {
  let text: string

  try {
    text = readFileSync(
      path,
      'utf8',
    ).trim()
  } catch {
    throw new HydraError({
      message: `report file not readable: ${path}`,
      code: 'NOT_FOUND',
    })
  }

  if (!text) {
    throw new HydraError({
      message: 'the report is empty',
      code: 'VALIDATION_ERROR',
    })
  }

  if (text.length > REPORT_MAX_CHARS) {
    throw new HydraError({
      message: `the report has ${text.length} characters; keep it under ${REPORT_MAX_CHARS}`,
      code: 'VALIDATION_ERROR',
    })
  }

  return text
}

export function decideReport({
  state,
  ref,
  text,
  meta,
}: {
  state: HydraState
  ref: string
  text: string
  meta: Meta
}) {
  const card = findCard({
    state,
    ref,
  })

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.report',
      data: { text },
    },
  })
}

// The latest stored report; every earlier one stays in the log.
export function readReport({
  hydraId,
  card,
}: {
  hydraId: string
  card: Card
}): string | undefined {
  if (!card.report) {
    return undefined
  }

  const id = card.report.id
  const event = readEvents({ hydraId }).find(e => e.id === id)

  return event?.type === 'task.report' ? event.data.text : undefined
}

// Only the owner, or Hydra on the owner's word, turns an investigation into its build.
export function decideBuild({
  state,
  ref,
  meta,
}: {
  state: HydraState
  ref: string
  meta: Meta
}) {
  const card = findCard({
    state,
    ref,
  })

  requireUnheld({ card })
  requireReady({
    state,
    card,
  })

  if (reportActor({ actor: meta.actor })) {
    throw new HydraError({
      message: 'only the owner, or Hydra on the owner\'s word, turns an investigation into its build',
      code: 'FORBIDDEN',
    })
  }

  if (card.kind !== 'investigation') {
    throw new HydraError({
      message: `task ${card.id} is already a build task`,
      code: 'CONFLICT',
    })
  }

  if (!card.report) {
    throw new HydraError({
      message: `task ${card.id} has no stored report to build from`,
      code: 'CONFLICT',
      help: ['The worker stores it with `pnyx-axi task report <task> --file <path>`'],
    })
  }

  requireReportReview({
    state,
    card,
  })

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.kind',
      data: {
        before: 'investigation',
        after: 'build',
      },
    },
  })
}

export function decideReportReview({
  state,
  ref,
  report,
  calls,
  none,
  meta,
}: {
  state: HydraState
  ref: string
  report: string
  calls: string[]
  none: boolean
  meta: Meta
}) {
  const card = findCard({
    state,
    ref,
  })

  if (!card.report || card.report.id !== report) {
    throw new HydraError({
      message: '--report must name the current stored report id',
      code: 'VALIDATION_ERROR',
    })
  }

  const hasCalls = calls.length > 0
  const invalidInventoryChoice = (none && hasCalls) || (!none && !hasCalls)

  if (invalidInventoryChoice) {
    throw new HydraError({
      message: 'review the whole report and pass --none or every --call <task>/<ask>',
      code: 'VALIDATION_ERROR',
    })
  }

  const records: ReportCall[] = calls.map(call => {
    const [
      taskRef,
      askId,
      extra,
    ] = call.split('/')
    const task = findCard({
      state,
      ref: taskRef ?? '',
    })
    const ask = task.asks?.find(ask => ask.id === askId)

    if (extra !== undefined || task.id === card.id || !ask || ask.audience !== 'owner'
      || ask.origin?.task !== card.id || ask.origin.report !== report) {
      throw new HydraError({
        message: `call ${call} must name an owner question linked to this report on a separate task`,
        code: 'VALIDATION_ERROR',
      })
    }

    return {
      task: task.id,
      ask: ask.id,
    }
  }).sort((
    a,
    b,
  ) => `${a.task}/${a.ask}`.localeCompare(`${b.task}/${b.ask}`))

  const recordedCalls = new Set(records.map(call => `${call.task}/${call.ask}`))

  if (recordedCalls.size !== records.length) {
    throw new HydraError({
      message: 'each report call must be listed once',
      code: 'VALIDATION_ERROR',
    })
  }

  const missing = reportCalls({
    state,
    card,
  }).some(call => !recordedCalls.has(`${call.task}/${call.ask}`))

  if (missing) {
    throw new HydraError({
      message: 'the inventory omits an unresolved report question',
      code: 'VALIDATION_ERROR',
    })
  }

  if (isDeepStrictEqual(
    card.report.review?.calls,
    records,
  )) {
    return { skipped: 'unchanged' as const }
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.report-reviewed',
      data: {
        report,
        calls: records,
      },
    },
  })
}
