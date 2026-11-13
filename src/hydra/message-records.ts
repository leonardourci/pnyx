import type { HydraEvent } from '#app/model.ts'
import { ownerActor } from '#app/actors.ts'
import { redact } from '#oracle/text.ts'
import { HYDRA_CARD } from './identity.ts'
import { joinMessageParts, placeEntries } from './history.ts'
import { reportActor } from './hydra.ts'
import type { SessionEntry, ThreadEntry } from './transcripts-read.ts'

export interface MessageRecord {
  id: string
  seq: number
  at: string
  role: string
  text: string
  aliases: string[]
  sequences: number[]
}

// entries are the thread's native transcript entries, each with its reference.
export function messageRecords({
  events,
  entries: native = [],
  card = HYDRA_CARD,
}: {
  events: HydraEvent[]
  entries?: SessionEntry[]
  card?: string
}): MessageRecord[] {
  const groups = new Map<string, ThreadEntry[]>()
  const sources = new Map<string, {
    seq: number
    alias?: string
  }[]>()
  const parts = new Set<string>()
  const messages = native.filter(entry => entry.kind === 'message'
    && (card !== HYDRA_CARD || entry.role.startsWith('assistant')))
  const recorded: {
    seq: number
    entry: ThreadEntry
    alias?: string
  }[] = placeEntries({
    events,
    entries: messages,
  }).map(({
    seq,
    entry,
  }) => ({
    seq,
    entry: {
      ...entry,
      messageId: entry.reference,
      part: entry.part ?? 0,
    },
  }))

  for (const event of events) {
    const actorRole = ownerActor({ actor: event.actor }) ? 'owner' : event.actor
    let entry: ThreadEntry

    if (card === HYDRA_CARD && event.type === 'hydra.message'
      && event.data.kind !== 'divider' && !reportActor({ actor: event.actor })) {
      entry = {
        id: event.id,
        kind: 'message',
        role: actorRole,
        text: [
          event.data.enteredText ?? event.data.text,
          event.data.details,
        ].filter(Boolean).join('\n\n'),
        at: event.at,
      }
    } else if (card !== HYDRA_CARD && event.cardId === card && event.type === 'card.replied' && event.data.text) {
      entry = {
        id: `reply:${event.data.reply}`,
        kind: 'message',
        role: actorRole,
        text: event.data.text,
        at: event.at,
      }
    } else {
      continue
    }

    recorded.push({
      seq: event.seq,
      entry,
      alias: event.id,
    })
  }

  for (const {
    seq,
    entry,
    alias,
  } of recorded) {
    const id = entry.messageId ?? entry.id
    const previous = sources.get(id) ?? []
    previous.push({
      seq,
      alias,
    })
    sources.set(
      id,
      previous,
    )
    const part = `${id}\n${entry.part ?? 0}`

    if (!parts.has(part)) {
      const group = groups.get(id) ?? []
      group.push(entry)
      groups.set(
        id,
        group,
      )
      parts.add(part)
    }
  }

  const entries = [...groups.values()].flatMap(group => joinMessageParts({
    entries: group.sort((
      a,
      b,
    ) => (a.part ?? 0) - (b.part ?? 0)),
  }))

  return entries.map(entry => {
    const id = entry.messageId ?? entry.id
    const source = sources.get(id)!

    return {
      id,
      seq: source[0].seq,
      at: entry.at!,
      role: entry.role,
      text: redact({ text: entry.text }),
      aliases: source.flatMap(item => item.alias ?? []),
      sequences: source.map(item => item.seq),
    }
  }).sort((
    a,
    b,
  ) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq)
}
