import { steeringText } from '#workers/steering-text.ts'
import type { TitanEvent } from '#app/model.ts'
import type { AgentRef } from '#workers/model.ts'
import { redact } from '#oracle/text.ts'
import { injectedInstructions, ownMessage } from './chat-messages.ts'
import { joinMessageParts } from './history.ts'
import type { ThreadEntry } from './transcripts-read.ts'

export function replyEchoes({
  card,
  events,
}: {
  card: string
  events: TitanEvent[]
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
    const sent = redact({
      text: [
        event.data.text,
        event.data.context,
      ].filter(Boolean).join('\n\n'),
    })
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
  const startedByOthrys = agent?.host === 'pnyx' && !adoptedFromTerminal

  if (startedByOthrys) {
    return new Set(inputs)
  }

  const messages = joinMessageParts({ entries: inputs })
  const othrysWords = ({ message }: { message: ThreadEntry }) => message.othrys === true
    || steeringText({ text: message.text })
    || injectedInstructions({
      entry: message,
      provider: agent?.provider,
    })
  const delivered = messages.filter(message => {
    if (othrysWords({ message })) {
      return true
    }

    return echoes.take({
      text: message.text,
      at: message.at,
    })
  })
  const deliveredMessages = new Set(delivered.map(message => messageOf({ entry: message })))

  return new Set(inputs.filter(entry => deliveredMessages.has(messageOf({ entry }))))
}
