import { matchesProject, sameProjectPath } from './identity.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { Link } from '#tasks/delivery/model.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { projectsFor } from './read.ts'
import { refreshProject } from './refresh.ts'

const pending = new Map<string, Promise<void>>()

export function refreshTarget({
  state,
  card,
  link,
}: {
  state: HydraState
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
  const state = loadHydra({ hydraId }).state
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
      const latest = loadHydra({ hydraId }).state
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
    complete: ({ result }) => withWriter({
      hydraId,
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
            actor: 'pnyx',
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
  const key = JSON.stringify([
    hydraId,
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
    hydraId,
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
