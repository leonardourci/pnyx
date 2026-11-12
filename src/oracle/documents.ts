import type { HydraState } from '#app/model.ts'
import { readEvents } from '#app/event-log.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { cardSessionId, sessionId } from '#workers/session-attachments.ts'
import { transcriptMessages } from '#workers/transcripts.ts'
import { readTranscript } from '#workers/transcript-read.ts'
import { isAbsolute } from 'node:path'
import type { Kind } from './model.ts'
import { chunk, eventText, redact, visibleText } from './text.ts'

const TRANSCRIPT_BATCH_BYTES = 256 * 1024

export interface Document {
  card: string
  kind: Kind
  at: string
  text: string
}

export function* documents({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}): Generator<Document> {
  const events = readEvents({ hydraId })
  const replaced = new Set(events.flatMap(event => event.type === 'chat.message' && event.data.replaces ? [event.data.replaces] : []))
  const archived = new Set<string>()
  const paths = new Map<string, {
    card: string
    session: string
  }>()
  const hydra = state.cards[HYDRA_CARD]
  const hydraSession = hydra && cardSessionId({ card: hydra })
  const target = ({
    card,
    session,
  }: {
    card: string
    session?: string
  }) => card === HYDRA_CARD || (session && session === hydraSession) ? '$board' : card

  const entries = function* ({
    card,
    kind,
    at,
    text,
  }: Document): Generator<Document> {
    for (const body of chunk({ text: redact({ text }) })) {
      yield {
        card: target({ card }),
        kind,
        at,
        text: body,
      }
    }
  }

  for (const event of events) {
    if (event.type === 'chat.message') {
      archived.add(`${event.data.session}:${event.data.nativeId}`)

      if (!replaced.has(event.id)) {
        yield* entries({
          card: event.cardId,
          kind: 'transcript',
          at: event.at,
          text: visibleText({ text: event.data.text }),
        })
      }
    } else if (event.type === 'hydra.helper-finished') {
      for (const outcome of event.data.outcomes) {
        if (outcome.status !== 'handled' && outcome.status !== 'still_waiting') {
          yield* entries({
            card: outcome.task,
            kind: 'event',
            at: event.at,
            text: outcome.summary,
          })
        }
      }
    } else {
      yield* entries({
        card: event.cardId,
        kind: event.type === 'card.noted' ? 'note' : 'event',
        at: event.type === 'card.noted' ? event.data.at ?? event.at : event.at,
        text: eventText({ event }),
      })
    }

    const agent = event.type === 'card.pushed' ? event.data.agent : undefined
    const path = agent?.transcriptPath

    if (agent && path && isAbsolute(path) && path.endsWith('.jsonl') && !paths.has(path)) {
      const session = sessionId({ agent })
      paths.set(
        path,
        {
          card: target({
            card: event.cardId,
            session,
          }),
          session,
        },
      )
    }
  }

  for (const [
    source,
    tracked,
  ] of paths) {
    let cursor = {
      source,
      identity: '',
      pos: 0,
    }

    for (let tail = readTranscript({
      cursor,
      maxBytes: TRANSCRIPT_BATCH_BYTES,
    }); tail?.lines.length; tail = readTranscript({
        cursor,
        maxBytes: TRANSCRIPT_BATCH_BYTES,
      })) {
      for (const line of tail.lines) {
        if (archived.has(`${tracked.session}:${line.pos}`)) {
          continue
        }

        for (const message of transcriptMessages({ record: line.record })) {
          yield* entries({
            card: tracked.card,
            kind: 'transcript',
            at: message.at ?? '',
            text: message.text,
          })
        }
      }

      cursor = {
        source,
        identity: tail.identity,
        pos: tail.end,
      }
    }
  }
}
