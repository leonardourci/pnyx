import type { HydraEvent } from '#app/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { Kind } from './model.ts'
import { chunk, eventText, redact, visibleText } from './text.ts'

export interface Document {
  card: string
  kind: Kind
  at: string
  text: string
}

export function* documentChunks({
  card,
  kind,
  at,
  text,
}: Document): Generator<Document> {
  for (const body of chunk({ text: redact({ text }) })) {
    yield {
      card: card === HYDRA_CARD ? '$board' : card,
      kind,
      at,
      text: body,
    }
  }
}

export function* eventDocuments({ event }: { event: HydraEvent }): Generator<Document> {
  if (event.type === 'chat.message') {
    if ((event.data.kind ?? 'message') === 'message' && !event.data.hidden) {
      yield* documentChunks({
        card: event.cardId,
        kind: 'transcript',
        at: event.at,
        text: visibleText({ text: event.data.text }),
      })
    }

    return
  }

  if (event.type === 'hydra.helper-finished') {
    for (const outcome of event.data.outcomes) {
      if (outcome.status !== 'handled' && outcome.status !== 'still_waiting') {
        yield* documentChunks({
          card: outcome.task,
          kind: 'event',
          at: event.at,
          text: outcome.summary,
        })
      }
    }

    return
  }

  yield* documentChunks({
    card: event.cardId,
    kind: event.type === 'card.noted' ? 'note' : 'event',
    at: event.type === 'card.noted' ? event.data.at ?? event.at : event.at,
    text: eventText({ event }),
  })
}
