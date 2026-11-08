import { readLog } from '#app/event-log.ts'
import { noteId } from '#tasks/notes.ts'
import type { ChatEvent } from './model.ts'

export function chatRecordId({
  session,
  nativeId,
  messageId,
  part,
}: Pick<ChatEvent['data'], 'session' | 'nativeId' | 'messageId' | 'part'>): string {
  const legacy = /^(.*)\.(\d+)$/.exec(nativeId)
  const message = messageId ?? legacy?.[1] ?? nativeId
  const position = part ?? (legacy ? Number(legacy[2]) : 0)

  return noteId({
    cardKey: session,
    ref: `chat:${JSON.stringify([
      message,
      position,
    ])}`,
  })
}

const recorded = new Map<string, {
  end: number
  ids: Set<string>
}>()

export function recordedChatIds({ dir }: { dir: string }): ReadonlySet<string> {
  let previous = recorded.get(dir)
  let tail = readLog({
    dir,
    from: previous?.end,
  })

  if (!tail) {
    previous = undefined
    // A read from zero returns a log or throws, even when the file is absent.
    tail = readLog({ dir })!
  }

  const ids = previous?.ids ?? new Set<string>()

  for (const event of tail.events) {
    if (event.type === 'chat.message') {
      ids.add(chatRecordId(event.data))
    }
  }

  recorded.set(
    dir,
    {
      end: tail.end,
      ids,
    },
  )

  return ids
}
