import { basename } from 'node:path'
import { readEventsFrom } from '#app/event-log.ts'
import { noteId } from '#tasks/notes.ts'
import { chatPosition, rememberChat } from './chat-events.ts'
import type { ChatEvent } from './model.ts'

export function chatRecordId({
  session,
  nativeId,
  messageId,
  part,
}: Pick<ChatEvent['data'], 'session' | 'nativeId' | 'messageId' | 'part'>): string {
  const {
    message,
    position,
  } = chatPosition({
    nativeId,
    messageId,
    part,
  })

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
  events: Map<string, ChatEvent>
}>()

export function recordedChats({ dir }: { dir: string }): Map<string, ChatEvent> {
  const previous = recorded.get(dir)
  // A Hydra's folder is named by its id.
  const tail = readEventsFrom({
    hydraId: basename(dir),
    offset: previous?.end ?? 0,
  })

  const events = previous?.events ?? new Map<string, ChatEvent>()

  for (const event of tail.events) {
    if (event.type === 'chat.message') {
      rememberChat({
        event,
        events,
      })
    }
  }

  recorded.set(
    dir,
    {
      end: tail.end,
      events,
    },
  )

  return events
}
