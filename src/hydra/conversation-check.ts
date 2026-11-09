import type { ThreadEntry, ThreadPage } from './transcripts-read.ts'

export interface ConversationMismatch {
  kind: 'missing' | 'duplicate' | 'order' | 'text' | 'tool' | 'progress' | 'hidden' | 'unexpected'
  reference: string
}

const reference = ({ entry }: { entry: ThreadEntry }) => entry.reference ?? entry.id

export function conversationEntries({ conversation }: {
  conversation: NonNullable<ThreadPage['conversation']>
}): ThreadEntry[] {
  return conversation.entries.flatMap(entry => [
    ...conversation.folds[entry.id]?.notes ?? [],
    entry,
  ])
}

export function checkConversation({
  expected,
  conversation,
  ordered = expected,
}: {
  expected: ThreadEntry[]
  conversation: NonNullable<ThreadPage['conversation']>
  ordered?: ThreadEntry[]
}): ConversationMismatch[] {
  const actual = conversationEntries({ conversation })
  const positions = new Map<string, {
    entry: ThreadEntry
    index: number
  }[]>()
  const mismatches: ConversationMismatch[] = []
  const known = new Set(expected.map(entry => reference({ entry })))

  for (const [
    index,
    entry,
  ] of actual.entries()) {
    const key = reference({ entry })

    if (entry.hidden) {
      mismatches.push({
        kind: 'hidden',
        reference: key,
      })
    }

    if (!known.has(key)) {
      mismatches.push({
        kind: 'unexpected',
        reference: key,
      })
    }

    positions.set(
      key,
      [
        ...positions.get(key) ?? [],
        {
          entry,
          index,
        },
      ],
    )
  }

  for (const [
    key,
    matches,
  ] of positions) {
    if (matches.length > 1) {
      mismatches.push({
        kind: 'duplicate',
        reference: key,
      })
    }
  }

  for (const entry of expected) {
    const key = reference({ entry })
    const found = positions.get(key)?.[0]

    if (!found) {
      let kind: ConversationMismatch['kind'] = 'missing'

      if (entry.kind === 'tool') {
        kind = 'tool'
      } else if (entry.kind === 'thinking' || entry.final === false) {
        kind = 'progress'
      }

      mismatches.push({
        kind,
        reference: key,
      })
      continue
    }

    if (found.entry.text !== entry.text) {
      mismatches.push({
        kind: 'text',
        reference: key,
      })
    }
  }

  let previous = -1

  for (const entry of ordered) {
    const key = reference({ entry })
    const found = positions.get(key)?.[0]

    if (!found) {
      continue
    }

    if (found.index < previous) {
      mismatches.push({
        kind: 'order',
        reference: key,
      })
    }

    previous = Math.max(
      previous,
      found.index,
    )
  }

  return mismatches
}
