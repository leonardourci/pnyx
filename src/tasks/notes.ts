import { createHash } from 'node:crypto'
import type { HydraState, Decision } from '../app/model.ts'
import { NOTE_KINDS, type Note } from './model.ts'
import { base, type Meta } from '../app/command-meta.ts'
import { findCard } from './push-rules.ts'
import { invalid, text } from '../app/command-validation.ts'
import { decided } from '../app/decision.ts'

// The event id of a harvested note: the same card and source record always give
// the same id, so a note is appended once however often its source is read.
export function noteId({
  cardKey,
  ref,
}: {
  cardKey: string
  ref: string
}): string {
  return `note_${createHash('sha256').update(`${cardKey}\n${ref}`)
    .digest('hex')
    .slice(
      0,
      20,
    )}`
}

export function decideNote(
  {
    state,
    ref,
    note,
    meta,
  }: {
    state: HydraState
    ref: string
    note: Note
    meta: Meta & {
      id: string
    }
  },
): Decision {
  const card = findCard({
    state,
    ref,
  })

  if (!(NOTE_KINDS as readonly string[]).includes(note.kind)) {
    throw invalid({ message: `note kind must be one of ${NOTE_KINDS.join(', ')}` })
  }

  const data: Note = {
    kind: note.kind,
    source: text({
      value: note.source,
      what: 'note source',
    }),
    text: text({
      value: note.text,
      what: 'note text',
    }),
  }

  if (note.at) {
    data.at = note.at
  }

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.noted',
      data,
    },
  })
}
