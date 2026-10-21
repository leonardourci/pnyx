import { appendNote } from '../integrations/hooks/harvest.ts'
import { liveTask } from '../core/tasks.ts'
import { taggedParagraphs, taskMentions } from '../mentions/mentions.ts'
import type { Writer } from '../store/hydra-store.ts'

// The card keeps the words the owner already read in chat, so no model is asked anything.
export function copyTagged({
  writer,
  texts,
  asks,
  at,
}: {
  writer: Writer
  texts: string[]
  // Ids of the owner's Hydra messages this turn took in.
  asks: string[]
  at: string
}): number {
  let added = 0
  const tagged = new Set<string>()

  texts.flatMap(text => taggedParagraphs({ text })).forEach((
    paragraph,
    index,
  ) => {
    const card = writer.state.cards[paragraph.id]

    if (!card || !liveTask({ card })) {
      return
    }

    tagged.add(card.id)
    added += appendNote({
      writer,
      cardId: card.id,
      note: {
        kind: 'context',
        source: 'hydra',
        text: paragraph.text,
        ref: `hydra-reply:${at}:${index}`,
      },
      at,
    })
  })

  for (const id of asks) {
    const message = writer.state.hydraMessages?.find(item => item.id === id)

    if (!message) {
      continue
    }

    // A message that names the task with its chip already shows in the task's history.
    const named = new Set(taskMentions({ text: message.text }).map(mention => mention.id))

    for (const cardId of tagged) {
      if (!named.has(cardId)) {
        added += appendNote({
          writer,
          cardId,
          note: {
            kind: 'context',
            source: 'owner',
            text: message.text,
            at: message.at,
            ref: `hydra-ask:${id}`,
          },
          at,
        })
      }
    }
  }

  return added
}
