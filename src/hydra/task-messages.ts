import { steeringText } from '#workers/inbox-notice.ts'
import type { HydraEvent } from '#app/model.ts'
import type { AgentRef } from '#workers/model.ts'
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

    const sent = parts.map(part => part.text).join('')
    sentTimes.set(
      sent,
      [
        ...sentTimes.get(sent) ?? [],
        sentAt,
      ],
    )
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
  agent,
}: {
  entries: ThreadEntry[]
  echoes: ReturnType<typeof replyEchoes>
  agent?: AgentRef
}): Set<ThreadEntry> {
  const inputs = entries.filter(entry => ownMessage({ entry }))
  const adoptedFromTerminal = agent?.resume === true
  const startedByPnyx = agent?.host === 'pnyx' && !adoptedFromTerminal

  if (startedByPnyx) {
    return new Set(inputs)
  }

  const messages = joinMessageParts({ entries: inputs })
  const pnyxWords = ({ message }: { message: ThreadEntry }) => steeringText({ text: message.text })
    || injectedInstructions({
      entry: message,
      provider: agent?.provider,
    })
  const fromPnyx = ({ message }: { message: ThreadEntry }) => message.pnyx === true
    || pnyxWords({ message })
    || echoes.take({
      text: message.text,
      at: message.at,
    })
  const delivered = messages.filter(message => fromPnyx({ message }))
  const deliveredMessages = new Set(delivered.map(message => messageOf({ entry: message })))

  return new Set(inputs.filter(entry => deliveredMessages.has(messageOf({ entry }))))
}
