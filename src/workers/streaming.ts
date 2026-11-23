import { splitEntry, type ThreadEntry, type ThreadPage } from '#hydra/transcripts-read.ts'
import type { HostedText } from './provider.ts'

export function liveReplies() {
  const messages = new Map<string, ThreadEntry>()
  const recorded = new Set<string>()
  let working = false
  let currentTurn: ThreadPage['currentTurn']

  return {
    start({
      ownerStarted,
    }: {
      ownerStarted?: boolean
    }) {
      messages.clear()
      recorded.clear()
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
          id,
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
      const saved = new Set(page.entries.filter(entry => entry.streaming === undefined)
        .map(entry => entry.messageId ?? entry.id))
      const entries: ThreadEntry[] = []

      for (const entry of messages.values()) {
        const id = page.session ? `${page.session}:${entry.id}` : entry.id

        if (saved.has(id)) {
          recorded.add(entry.id)
        }

        if (!recorded.has(entry.id) && entry.text) {
          entries.push(...splitEntry({
            entry: {
              ...entry,
              id,
              session: page.session,
              reference: page.session ? id : undefined,
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
        ],
      }

      if (currentTurn) {
        result.currentTurn = currentTurn
      }

      return result
    },
  }
}
