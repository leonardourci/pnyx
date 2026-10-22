import { appendNote } from '../integrations/hooks/harvest.ts'
import { ownerActor } from '../core/model.ts'
import { liveTask } from '../core/tasks.ts'
import { taggedParagraphs, taskMentions } from '../mentions/mentions.ts'
import { redact } from '../oracle/text.ts'
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
  // Ids of the Hydra messages this turn answered.
  asks: string[]
  at: string
}) {
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
    appendNote({
      writer,
      cardId: card.id,
      note: {
        kind: 'context',
        source: 'hydra',
        text: redact({ text: paragraph.text }),
        ref: `hydra-reply:${at}:${index}`,
      },
      at,
    })
  })

  for (const id of asks) {
    const message = writer.state.hydraMessages?.find(item => item.id === id)

    // Workers and Pnyx also write Hydra messages; only the owner's chat counts as an ask.
    if (!message || message.action !== 'send' || !ownerActor({ actor: message.actor })) {
      continue
    }

    // A message sent to the task, or naming it with its chip, already shows in its history.
    const named = new Set(taskMentions({ text: message.text }).map(mention => mention.id))

    for (const cardId of tagged) {
      if (message.task !== cardId && !named.has(cardId)) {
        appendNote({
          writer,
          cardId,
          note: {
            kind: 'context',
            source: 'owner',
            text: redact({ text: message.text }),
            at: message.at,
            ref: `hydra-ask:${id}`,
          },
          at,
        })
      }
    }
  }
}
