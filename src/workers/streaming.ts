import { splitEntry, type ThreadEntry, type ThreadPage } from '#hydra/transcripts-read.ts'
import { redact } from '#oracle/text.ts'
import type { HostedText } from './provider.ts'

// These are disposable transport entries; the harness transcript remains the history.
export function liveReplies() {
  const messages = new Map<string, ThreadEntry>()
  let offset = 0, working = false
  let currentTurn: ThreadPage['currentTurn']

  return {
    start({
      offset: start,
      ownerStarted,
    }: {
      offset: number
      ownerStarted?: boolean
    }) {
      messages.clear()
      offset = start
      working = true

      if (ownerStarted !== undefined) {
        currentTurn = {
          at: new Date().toISOString(),
          owner: ownerStarted,
        }
      }
    },
    update({
      id,
      text,
      append,
    }: Omit<HostedText, 'type'>) {
      const prior = messages.get(id)
      messages.set(
        id,
        {
          id: `live:${id}`,
          kind: 'message',
          role: 'assistant',
          text: (append ? prior?.text ?? '' : '') + text,
          at: prior?.at ?? new Date().toISOString(),
        },
      )
    },
    finish() {
      working = false
    },
    texts() {
      return [...messages.values()].map(entry => entry.text)
    },
    page({ page }: { page: ThreadPage }): ThreadPage {
      const saved = new Map<string, string>()

      for (const entry of page.entries) {
        const id = entry.messageId ?? entry.id

        if (entry.kind === 'message' && entry.role.startsWith('assistant') && Number.parseInt(id) >= offset) {
          saved.set(
            id,
            (saved.get(id) ?? '') + entry.text,
          )
        }
      }

      const entries: ThreadEntry[] = []

      for (const entry of messages.values()) {
        const text = redact({ text: entry.text })
        const match = [...saved].find(([
          , value,
        ]) => value === text
          || (working && text.length > 0 && value.startsWith(text)))

        if (match) {
          saved.delete(match[0])
        } else if (text) {
          entries.push(...splitEntry({
            entry: {
              ...entry,
              streaming: working,
            },
          }))
        }
      }

      const result: ThreadPage = {
        ...page,
        entries: [
          ...page.entries,
          ...entries,
        ].slice(-60),
      }

      if (currentTurn) {
        result.currentTurn = currentTurn
      }

      return result
    },
  }
}
