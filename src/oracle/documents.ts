import { OWNER_DOCUMENTS } from '#memory/budgets.ts'
import type { HydraEvent } from '#app/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { Kind } from './model.ts'
import { chunk, eventText, redact } from './text.ts'

export interface Document {
  memory?: number
  project?: string
  card: string
  kind: Kind
  at: string
  text: string
}

function* documentChunks({
  card,
  kind,
  at,
  text,
  memory = 0,
}: Document): Generator<Document> {
  for (const body of chunk({ text: redact({ text }) })) {
    yield {
      memory,
      card: card === HYDRA_CARD ? '$board' : card,
      kind,
      at,
      text: body,
    }
  }
}

export function* eventDocuments({ event }: { event: HydraEvent }): Generator<Document> {
  // Conversation copies an older Pnyx logged are agent transcripts, not Pnyx data.
  if (event.type === 'chat.message' || (event.type === 'hydra.memory' && Object.hasOwn(
    OWNER_DOCUMENTS,
    event.data.key,
  ))) {
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
    memory: event.type === 'hydra.memory' ? 1 : 0,
    at: event.type === 'card.noted' ? event.data.at ?? event.at : event.at,
    text: eventText({ event }),
  })
}
