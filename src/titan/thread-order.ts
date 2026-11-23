import type { ThreadEntry } from './transcripts-read.ts'

export function threadEntryOrder({
  first,
  second,
}: {
  first: ThreadEntry
  second: ThreadEntry
}) {
  const time = (first.at ?? '').localeCompare(second.at ?? '')

  if (time || first.session !== second.session) {
    return time
  }

  if (first.offset === undefined || second.offset === undefined) {
    return 0
  }

  return first.offset - second.offset
    || (first.block ?? 0) - (second.block ?? 0)
    || (first.part ?? 0) - (second.part ?? 0)
}
