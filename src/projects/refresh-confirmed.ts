import { matchesProject, sameProjectPath } from './identity.ts'
import { hydraEvent } from '#titan/titan.ts'
import type { TitanState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { Link } from '#tasks/delivery/model.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { projectsFor } from './read.ts'
import { refreshProject } from './refresh.ts'

const pending = new Map<string, Promise<void>>()

export function refreshTarget({
  state,
  card,
  link,
}: {
  state: TitanState
  card: Card
  link: Link
}): string | undefined {
  if (link.state !== 'merged' || !link.mergeProof
    || card.projectRefresh?.[link.url]?.merge === link.mergeProof.commit) {
    return undefined
  }

  return projectsFor({ state }).find(project => !project.detached
    && matchesProject({
      project,
      ref: card.project,
    }))?.path
}

async function recordRefresh({
  titanId,
  cardId,
  url,
  proof,
}: {
  titanId: string
  cardId: string
  url: string
  proof: NonNullable<Link['mergeProof']>
}): Promise<void> {
  const state = loadTitan({ titanId }).state
  const card = state.cards[cardId]
  const link = card?.links.find(link => link.url === url)

  if (!card || !link || link.mergeProof?.commit !== proof.commit) {
    return
  }

  const path = refreshTarget({
    state,
    card,
    link,
  })

  if (!path) {
    return
  }

  await refreshProject({
    path,
    url,
    merge: proof.commit,
    isPending: () => {
      const latest = loadTitan({ titanId }).state
      const current = latest.cards[cardId]
      const confirmed = current?.links.find(link => link.url === url)

      if (!current || !confirmed || confirmed.mergeProof?.head !== proof.head
        || confirmed.mergeProof.commit !== proof.commit) {
        return false
      }

      return sameProjectPath({
        left: path,
        right: refreshTarget({
          state: latest,
          card: current,
          link: confirmed,
        }),
      })
    },
    complete: async ({ result }) => await withWriter({
      titanId,
      fn: ({ writer }) => {
        const latest = writer.state.cards[cardId]
        const confirmed = latest?.links.find(link => link.url === url)

        if (confirmed?.state !== 'merged' || confirmed.mergeProof?.commit !== proof.commit
          || confirmed.mergeProof.head !== proof.head
        || latest?.projectRefresh?.[url]?.merge === proof.commit) {
          return
        }

        if (!latest || !sameProjectPath({
          left: path,
          right: refreshTarget({
            state: writer.state,
            card: latest,
            link: confirmed,
          }),
        })) {
          return
        }

        const decision = hydraEvent({
          state: writer.state,
          cardId,
          meta: {
            actor: 'othrys',
            at: new Date().toISOString(),
          },
          change: {
            type: 'project.refreshed',
            data: result,
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    }),
  })
}

export async function refreshConfirmedProject({
  titanId,
  cardId,
  url,
  proof,
}: {
  titanId: string
  cardId: string
  url: string
  proof: NonNullable<Link['mergeProof']>
}): Promise<void> {
  const key = JSON.stringify([
    titanId,
    cardId,
    url,
    proof.commit,
  ])
  const running = pending.get(key)

  if (running) {
    await running

    return
  }

  const operation = recordRefresh({
    titanId,
    cardId,
    url,
    proof,
  })
  pending.set(
    key,
    operation,
  )

  try {
    await operation
  } finally {
    pending.delete(key)
  }
}
