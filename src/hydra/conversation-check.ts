import { ownMessage } from './chat-messages.ts'
import { lateOwnerMessages } from './conversation.ts'
import type { HydraMessage } from './model.ts'
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
    ...conversation.trailing[entry.id] ?? [],
  ])
}

export function checkConversation({
  expected,
  conversation,
  ordered = expected,
  sent = [],
}: {
  expected: ThreadEntry[]
  conversation: NonNullable<ThreadPage['conversation']>
  ordered?: ThreadEntry[]
  // The owner's messages in the order they were sent.
  sent?: ThreadEntry[]
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

  for (const list of [
    ordered,
    sent,
  ]) {
    let previous = -1

    for (const entry of list) {
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
  }

  return mismatches
}

// The checkers' own statement of the order rule, apart from the chat's sorting: entries follow time, except that an owner
// message the agent read late is checked only against the order the owner sent them in.
export function ownerSendOrder({
  messages,
  expected,
}: {
  messages: HydraMessage[]
  expected: ThreadEntry[]
}) {
  const sentAt = new Map(messages.map((
    message,
    index,
  ) => [
    message.id,
    index,
  ]))
  const sent = expected.flatMap(entry => {
    const index = sentAt.get(entry.reference ?? '')

    return ownMessage({ entry }) && index !== undefined ? [
      {
        entry,
        index,
      },
    ] : []
  })
    .toSorted((
      a,
      b,
    ) => a.index - b.index)
    .map(({ entry }) => entry)

  return {
    late: lateOwnerMessages({
      messages,
      entries: expected,
    }),
    sent,
  }
}
