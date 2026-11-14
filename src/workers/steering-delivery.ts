import { attachedImages } from '#hydra/images.ts'
import { acknowledgeSteering, recordSteeringAttempt } from './inbox.ts'
import { activeCompaction } from '#workers/compaction/state.ts'
import { pendingSteering, steeringClaim, sameClaim, steeringWorkerIdentity, steeringHeld } from './steering.ts'
import { steeringNotice } from './inbox-notice.ts'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask } from '#tasks/select.ts'
import { sessionId } from './session-attachments.ts'
import { pnyxHome } from '#store/storage.ts'
import type { Live } from '#app/host-types.ts'
import type { Writer } from '#app/writer.ts'

function keyForSteering({
  card,
  ids,
}: {
  card: Card
  ids: string[]
}): string {
  return createHash('sha256').update(JSON.stringify([
    card.agent?.sessionId,
    ids,
  ]))
    .digest('hex')
}

// A worker's steering inbox reaching its session: the doorbell with the words or the IDs, and marking read what it took.
export function createSteeringDelivery({
  hydraId,
  at,
  write,
  note,
}: {
  hydraId: string
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): void
}) {
  const pendingSteeringIds = ({
    card,
    key,
    generation,
    ids,
  }: {
    card?: Card
    key: string
    generation?: number
    ids: string[]
  }) => {
    if (!card?.agent || !liveTask({ card }) || sessionId({ agent: card.agent }) !== key
      || card.steeringGeneration !== generation || steeringHeld({ card })) {
      return []
    }

    return (card.steering ?? []).filter(message =>
      !message.ack && !message.stopped && ids.includes(message.id))
      .map(message => message.id)
  }

  const inboxNotice = ({
    card,
    ids,
  }: {
    card: Card
    ids: string[]
  }) => {
    const messages = (card.steering ?? []).filter(message => ids.includes(message.id))
    const images = messages.flatMap(message => attachedImages({
      text: message.text,
      hydras: join(
        pnyxHome(),
        'hydras',
      ),
    }))

    return [
      steeringNotice({
        task: card.id,
        hydraId,
        ids,
      }),
      ...new Set(images.map(path => `[image: ${path}]`)),
    ].join('\n')
  }

  const unnotifiedSteering = ({
    card,
    entry,
    message: ref,
    attempt,
  }: {
    card: Card
    entry?: Live
    message?: string
    attempt?: string
  }) => {
    const sameOpening = entry?.task === card.id && entry.generation === card.steeringGeneration

    return [...(card.steering ?? [])].sort((
      a,
      b,
    ) => Number(b.id === card.compaction?.priority)
            - Number(a.id === card.compaction?.priority)).filter(message => {
      if (message.ack || message.stopped) {
        return false
      }

      if (attempt) {
        const alreadyAttempted = message.attempts.some(known => known.id === attempt)

        return message.id === ref && !alreadyAttempted
      }

      return !sameOpening || !entry.steering.has(message.id)
    })
  }

  // The worker took instructions that carried their words, so they count as read for it, oldest first.
  const markRead = ({
    card: ref,
    ids,
    taken,
  }: {
    card: string
    ids: string[]
    // When the agent's harness took them, by its own record.
    taken?: string
  }) => note({
    fn: ({ writer }) => {
      const card = writer.state.cards[ref]
      const claim = card && steeringClaim({ card })

      if (!card || !claim) {
        return
      }

      const worker = `worker:${card.id}`

      for (const message of pendingSteering({ card }).filter(message => ids.includes(message.id))) {
        acknowledgeSteering({
          writer,
          ref: card.id,
          id: message.id,
          ack: {
            at: taken ?? at(),
            actor: worker,
            claim,
            outcome: 'read',
          },
          meta: {
            actor: worker,
            at: at(),
          },
          worker: steeringWorkerIdentity({
            state: writer.state,
            card,
          }),
        })
      }
    },
  })

  const ringSteering = ({
    card,
    entry,
    message: ref,
    attempt,
  }: {
    card: Card
    entry: Live
    message?: string
    attempt?: string
  }) => {
    if (card.id === HYDRA_CARD || !liveTask({ card })
      || steeringHeld({ card }) || activeCompaction({ card })) {
      return
    }

    const claim = steeringClaim({ card })

    if (!claim) {
      return
    }

    const messages = unnotifiedSteering({
      card,
      entry,
      message: ref,
      attempt,
    })

    if (!messages.length) {
      return
    }

    const ids = messages.map(message => message.id)

    for (const id of ids) {
      entry.steering.add(id)
    }

    // Messages never tried before go in as their words; a repeat only names their IDs.
    entry.input.push({
      id: `steering:${keyForSteering({
        card,
        ids,
      })}`,
      text: '',
      steeringIds: ids,
      inline: messages.every(message => !message.attempts.length),
    })
    write({
      fn: ({ writer }) => {
        const current = writer.state.cards[card.id]

        if (!current || !sameClaim({
          current: steeringClaim({ card: current }),
          claim,
        })) {
          return
        }

        for (const message of messages) {
          if (current.steering?.find(stored => stored.id === message.id)?.ack) {
            continue
          }

          recordSteeringAttempt({
            writer,
            ref: card.id,
            id: message.id,
            attempt: {
              id: attempt ?? randomUUID(),
              claim,
              at: at(),
              actor: 'pnyx',
              result: 'delivered',
            },
            meta: {
              actor: 'pnyx',
              at: at(),
            },
          })
        }
      },
    })
  }

  return {
    pendingSteeringIds,
    inboxNotice,
    unnotifiedSteering,
    markRead,
    ringSteering,
  }
}
