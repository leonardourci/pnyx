import { steeringText } from '#workers/inbox-notice.ts'
import type { HydraEvent } from '#app/model.ts'
import { injectedInstructions, ownMessage } from './chat-messages.ts'
import { joinMessageParts } from './history.ts'
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
      const echoed = times.findLastIndex(sentAt => sentAt <= writtenAt)

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

const messageOf = ({ entry }: { entry: ThreadEntry }) => entry.messageId ?? entry.id

export function deliveredInputs({
  entries,
  echoes,
  hosted,
  provider,
}: {
  entries: ThreadEntry[]
  echoes: ReturnType<typeof replyEchoes>
  hosted: boolean
  provider?: string
}): Set<ThreadEntry> {
  const inputs = entries.filter(entry => ownMessage({ entry }))
  const messages = joinMessageParts({ entries: inputs })
  const pnyxWords = ({ message }: { message: ThreadEntry }) => steeringText({ text: message.text })
    || injectedInstructions({
      entry: message,
      provider,
    })
  const injected = messages.filter(message => pnyxWords({ message }))
  const injectedMessages = new Set(injected.map(message => messageOf({ entry: message })))

  return new Set(inputs.filter(entry => {
    const pnyxInput = hosted || entry.pnyx === true || injectedMessages.has(messageOf({ entry }))

    return pnyxInput || echoes.take({
      text: entry.text,
      at: entry.at,
    })
  }))
}
