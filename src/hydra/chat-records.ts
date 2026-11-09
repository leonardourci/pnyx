import { readLog } from '#app/event-log.ts'
import { noteId } from '#tasks/notes.ts'
import type { HydraEvent } from '#app/model.ts'
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

function rememberChat({
  event,
  events,
}: {
  event: ChatEvent
  events: Map<string, ChatEvent>
}) {
  const identity = chatRecordId(event.data)
  const known = events.get(identity)

  if (!known || event.data.replaces === known.id) {
    events.set(
      identity,
      event,
    )
  }
}

const recorded = new Map<string, {
  end: number
  events: Map<string, ChatEvent>
}>()

export function recordedChats({ dir }: { dir: string }): ReadonlyMap<string, ChatEvent> {
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

export function effectiveChatEvents({ events }: { events: HydraEvent[] }): HydraEvent[] {
  const chosen = new Map<string, ChatEvent>()

  for (const event of events) {
    if (event.type !== 'chat.message') {
      continue
    }

    rememberChat({
      event,
      events: chosen,
    })
  }

  return events.filter(event => event.type !== 'chat.message'
    || chosen.get(chatRecordId(event.data)) === event)
}
