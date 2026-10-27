import { HydraError, type Card, type ReportCall } from '../core/model.ts'
import { type HydraState } from '../app/model.ts'

export function reportCalls({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): ReportCall[] {
  return Object.values(state.cards).flatMap(task => (task.asks ?? [])
    .filter(ask => ask.origin?.task === card.id && ask.origin.report === card.report?.id
      && !ask.answered && !ask.closed)
    .map(ask => ({
      task: task.id,
      ask: ask.id,
    })))
}

export function reportReviewGaps({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): string[] {
  if (!card.report) {
    return []
  }

  const review = card.report.review

  if (!review) {
    return [`report ${card.report.id} needs an explicit decision inventory with task report-review`]
  }

  const missing = reportCalls({
    state,
    card,
  }).filter(call => !review.calls.some(record =>
    record.task === call.task && record.ask === call.ask))

  return missing.map(call => `report decision ${call.task}/${call.ask} is missing from its inventory`)
}

export function requireReportReview({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): void {
  const gaps = reportReviewGaps({
    state,
    card,
  })

  if (gaps.length) {
    throw new HydraError({
      message: gaps.join('; '),
      code: 'REPORT_REVIEW_REQUIRED',
    })
  }
}
