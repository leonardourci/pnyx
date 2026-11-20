import { steeringText } from '#workers/inbox-notice.ts'
import type { HydraEvent } from '#app/model.ts'
import { injectedInstructions, ownMessage } from './chat-messages.ts'
import { splitEntry, type ThreadEntry } from './transcripts-read.ts'

export function replyEchoes({
  card,
  events,
}: {
  card: string
  events: HydraEvent[]
}) {
  const sentTimes = new Map<string, number[]>()
  const counted = new Set<string>()

  for (const event of events) {
    if (event.type !== 'card.replied' || event.cardId !== card || !event.data.text) {
      continue
    }

    if (counted.has(event.data.reply)) {
      continue
    }

    counted.add(event.data.reply)
    const sentAt = Date.parse(event.at)
    const parts = splitEntry({
      entry: {
        id: event.data.reply,
        role: 'user',
        kind: 'message',
        text: [
          event.data.text,
          event.data.context,
        ].filter(Boolean).join('\n\n'),
      },
    })

    for (const part of parts) {
      sentTimes.set(
        part.text,
        [
          ...sentTimes.get(part.text) ?? [],
          sentAt,
        ],
      )
    }
  }

  return {
    take({
      text,
      at,
    }: {
      text: string
      at?: string
    }): boolean {
      const times = sentTimes.get(text) ?? []
      const writtenAt = at === undefined ? Infinity : Date.parse(at)
      const echoed = times.findIndex(sentAt => sentAt <= writtenAt)

      if (echoed < 0) {
        return false
      }

      times.splice(
        echoed,
        1,
      )

      return true
    },
  }
}

export function deliveredInput({
  entry,
  echoes,
  hosted,
  provider,
}: {
  entry: ThreadEntry
  echoes: ReturnType<typeof replyEchoes>
  hosted: boolean
  provider?: string
}): boolean {
  if (!ownMessage({ entry })) {
    return false
  }

  const injected = steeringText({ text: entry.text }) || injectedInstructions({
    entry,
    provider,
  })
  const pnyxInput = hosted || entry.pnyx === true || injected

  return pnyxInput || echoes.take({
    text: entry.text,
    at: entry.at,
  })
}
