import { steeringText } from '#workers/inbox-notice.ts'
import type { HydraEvent } from '#app/model.ts'
import { injectedInstructions, ownMessage } from './chat-messages.ts'
import { splitEntry, type ThreadEntry } from './transcripts-read.ts'

// The copies of a task's replies its transcript can hold, as Pnyx sent them: words and context, in transport parts.
// Each copy accounts for one transcript line, so words the owner typed again in the terminal still show.
export function replyEchoes({
  card,
  events,
}: {
  card: string
  events: HydraEvent[]
}) {
  const sent = new Map<string, number>()

  for (const event of events) {
    if (event.type !== 'card.replied' || event.cardId !== card || !event.data.text) {
      continue
    }

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
      sent.set(
        part.text,
        (sent.get(part.text) ?? 0) + 1,
      )
    }
  }

  return {
    take({ text }: { text: string }): boolean {
      const left = sent.get(text) ?? 0

      if (!left) {
        return false
      }

      sent.set(
        text,
        left - 1,
      )

      return true
    },
  }
}

// A user line Pnyx or the harness put in a task's transcript, not words the owner typed into the agent's terminal:
// every user line of a session Pnyx runs, and elsewhere a copy of a reply, a steering notice, a start prompt or Codex's
// AGENTS.md block.
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
  if (!ownMessage({ entry }) || entry.replyId !== undefined) {
    return false
  }

  const injected = steeringText({ text: entry.text }) || injectedInstructions({
    entry,
    provider,
  })

  return hosted || entry.pnyx === true || injected || echoes.take({ text: entry.text })
}
