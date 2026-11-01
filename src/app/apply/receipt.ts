import { isDeepStrictEqual } from 'node:util'
import { clip, type Output } from '#app/cli-support.ts'

const COLLECTION_SAMPLE = 5
const SUMMARY_DEPTH = 2

function summary({
  value,
  depth = 0,
}: {
  value: unknown
  depth?: number
}): unknown {
  if (typeof value === 'string') {
    return clip({ text: value })
  }

  if (Array.isArray(value)) {
    return {
      count: value.length,
      sample: value.slice(-COLLECTION_SAMPLE).map(entry => summary({
        value: entry,
        depth: depth + 1,
      })),
    }
  }

  if (value !== null && typeof value === 'object') {
    if (depth >= SUMMARY_DEPTH) {
      return { fields: Object.keys(value) }
    }

    return Object.fromEntries(Object.entries(value).map(([
      field,
      entry,
    ]) => [
      field,
      summary({
        value: entry,
        depth: depth + 1,
      }),
    ]))
  }

  return value ?? null
}

export function taskDiff({
  task,
  before,
  after,
}: {
  task: string
  before: Record<string, unknown> | null
  after: Record<string, unknown>
}): Output {
  const fields = [
    ...new Set([
      ...Object.keys(before ?? {}),
      ...Object.keys(after),
    ]),
  ]
    .filter(field => !isDeepStrictEqual(
      before?.[field],
      after[field],
    ))
  const changed = ({ card }: { card: Record<string, unknown> }) => Object.fromEntries(fields.map(
    field => [
      field,
      summary({ value: card[field] }),
    ],
  ))

  return {
    task,
    fields,
    before: before ? changed({ card: before }) : null,
    after: changed({ card: after }),
  }
}

// Older durable receipts contain complete cards; retries must not re-emit their histories.
export function compactReceipt({ output }: { output: Output }): Output {
  if (!Array.isArray(output.diff)) {
    return output
  }

  return {
    ...output,
    diff: output.diff.map(entry => {
      if ('fields' in entry) {
        return entry
      }

      return taskDiff(entry)
    }),
  }
}
