import type { HydraEvent } from '#app/model.ts'
import type { ThreadEntry } from '#hydra/transcripts-read.ts'

// Nine native Hydra replies, each a second after one log event that gives it its seq.
export const lookupEvents: HydraEvent[] = Array.from(
  { length: 9 },
  (
    _,
    index,
  ) => ({
    v: 1,
    seq: index + 1,
    id: `event-${index + 1}`,
    cardId: `task-${index + 1}`,
    actor: 'web',
    at: `2026-01-01T00:00:0${index}.000Z`,
    type: 'task.created',
    data: {
      key: `task-${index + 1}`,
      title: `Task ${index + 1}`,
    },
  }),
)

export const lookupEntries: ThreadEntry[] = lookupEvents.map((
  event,
  index,
) => ({
  id: `${index}:m0`,
  reference: `original:${index}:m0`,
  session: 'original',
  kind: 'message',
  role: 'assistant',
  text: `Recorded reply ${index + 1}.`,
  at: event.at.replace(
    '.000Z',
    '.500Z',
  ),
}))
