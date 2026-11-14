import { refreshConfirmedProject } from '#projects/refresh-confirmed.ts'
import { declareTask } from '#tasks/declarations.ts'
import { cardFacts } from '#tasks/columns.ts'
import type { Link } from './model.ts'
import { withWriter, type Writer } from '#app/writer.ts'

function declareMerged({
  writer,
  cardId,
  url,
  at,
}: {
  writer: Writer
  cardId: string
  url: string
  at: string
}): void {
  const card = writer.state.cards[cardId]

  if (!card || card.status?.state === 'done') {
    return
  }

  // The same done fact that places cards; a task whose report awaits review is tried again on the next follow pass.
  if (!cardFacts({
    card,
    state: writer.state,
  }).includes('done')) {
    return
  }

  const decision = declareTask({
    state: writer.state,
    ref: card.id,
    status: 'done',
    note: `Pull request ${url} merged`,
    meta: {
      actor: 'pnyx',
      at,
    },
  })

  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}

export async function confirmedMerge({
  hydraId,
  cardId,
  url,
  proof,
}: {
  hydraId: string
  cardId: string
  url: string
  proof: NonNullable<Link['mergeProof']>
}): Promise<void> {
  const confirmed = withWriter({
    hydraId,
    fn: ({ writer }) => {
      const link = writer.state.cards[cardId]?.links.find(link => link.url === url)

      if (link?.state !== 'merged' || link.mergeProof?.head !== proof.head
      || link.mergeProof.commit !== proof.commit) {
        return false
      }

      declareMerged({
        writer,
        cardId,
        url,
        at: proof.confirmedAt,
      })

      return true
    },
  })

  if (confirmed) {
    await refreshConfirmedProject({
      hydraId,
      cardId,
      url,
      proof,
    })
  }
}
