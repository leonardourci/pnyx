import { sessionId } from './session-attachments.ts'
import { sessionFields } from './session-facts.ts'
import { scanEvents } from '#app/event-log.ts'
import { loadTitan } from '#app/store.ts'

export function taskSessions({
  hydraId,
  ids,
}: {
  hydraId: string
  ids: Set<string>
}): Set<string> {
  const sessions = new Set<string>()

  for (const session of Object.values(loadTitan({ hydraId }).state.sessions ?? {})) {
    if (ids.has(session.originCardId) || ids.has(session.taskId ?? '')) {
      sessions.add(session.id)
    }
  }

  for (const event of scanEvents({
    hydraId,
    cardIds: [...ids],
    types: [
      'task.session',
      'task.moved-in',
      'task.edited',
      'session.observed',
    ],
  })) {
    if (event.type === 'task.session' && (ids.has(event.data.before ?? '') || ids.has(event.data.after ?? ''))) {
      sessions.add(event.data.session)
    }

    if (ids.has(event.cardId) && event.type === 'task.moved-in') {
      for (const session of event.data.sessions) {
        sessions.add(session.id)
      }
    }

    const fields = sessionFields({ event })

    if (ids.has(event.cardId) && fields?.agent) {
      const agent = fields.agent
      sessions.add(sessionId({ agent }))
    }
  }

  return sessions
}
