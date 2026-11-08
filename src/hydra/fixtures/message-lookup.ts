import type { ChatEvent } from '#hydra/model.ts'

export const lookupEvents: ChatEvent[] = Array.from(
  { length: 9 },
  (
    _,
    index,
  ) => ({
    v: 1,
    seq: index + 1,
    id: `event-${index + 1}`,
    cardId: '$hydra',
    actor: 'session:original',
    at: `2026-01-01T00:00:0${index}.000Z`,
    type: 'chat.message',
    data: {
      session: 'original',
      nativeId: `${index}:m0`,
      role: 'assistant',
      text: `Recorded reply ${index + 1}.`,
    },
  }),
)
