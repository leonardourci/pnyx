import type { ThreadEntry } from './transcripts-read.ts'

const NATIVE_POSITION = /(?:^|:)(\d+):([mt])(\d+)(?:\.(\d+))?$/

function nativePosition({ entry }: { entry: ThreadEntry }) {
  const identities = [
    entry.messageId,
    entry.reference,
    entry.id,
  ]
  const match = identities.map(identity => NATIVE_POSITION.exec(identity ?? '')).find(Boolean)

  if (!match) {
    return undefined
  }

  return {
    offset: Number(match[1]),
    kind: match[2] === 'm' ? 0 : 1,
    block: Number(match[3]),
    part: entry.part ?? Number(match[4] ?? 0),
  }
}

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

  const before = nativePosition({ entry: first })
  const after = nativePosition({ entry: second })

  if (!before || !after) {
    return 0
  }

  return before.offset - after.offset || before.kind - after.kind
    || before.block - after.block || before.part - after.part
}
