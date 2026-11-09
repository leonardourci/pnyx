import type { HydraEvent } from '#app/model.ts'
import type { ChatEvent } from './model.ts'

export function chatPosition({
  nativeId,
  messageId,
  part,
}: Pick<ChatEvent['data'], 'nativeId' | 'messageId' | 'part'>) {
  const legacy = /^(.*)\.(\d+)$/.exec(nativeId)

  return {
    message: messageId ?? legacy?.[1] ?? nativeId,
    position: part ?? (legacy ? Number(legacy[2]) : 0),
  }
}

export function chatRecordKey({ data }: { data: ChatEvent['data'] }) {
  const {
    message,
    position,
  } = chatPosition(data)

  return JSON.stringify([
    data.session,
    message,
    position,
  ])
}

export function rememberChat({
  event,
  events,
}: {
  event: ChatEvent
  events: Map<string, ChatEvent>
}) {
  const identity = chatRecordKey({ data: event.data })
  const known = events.get(identity)

  if (!known || event.data.replaces === known.id) {
    events.set(
      identity,
      event,
    )
  }
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
    || chosen.get(chatRecordKey({ data: event.data })) === event)
}
