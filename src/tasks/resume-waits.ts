import type { HydraState } from '#app/model.ts'
import { clip } from '#hydra/digest.ts'
import { base } from '#app/command-meta.ts'
import { withWriter } from '#app/writer.ts'
import { activeHelperBatches } from '#routine-helper/state.ts'
import { activeCompaction } from '#workers/compaction/state.ts'
import { steeringClaim, steeringHeld } from '#workers/steering.ts'
import { notifySteering } from '#workers/inbox-delivery.ts'
import { loadHydra } from '#app/store.ts'
import { openAsks } from './ask-state.ts'
import { ownerGates } from './owner-gates.ts'
import { liveTask } from './select.ts'
import { taskReadiness } from './dependencies.ts'
import { waitReadiness } from './waits.ts'
import type { Card } from './model.ts'

const RESUME_TITLE_CHARS = 100

function unnotifiedResumes({
  state,
  retryAfter,
  now,
}: {
  state: HydraState
  retryAfter: Map<string, number>
  now: number
}) {
  const pending = Object.values(state.cards).flatMap(card => {
    if (!liveTask({ card }) || !steeringClaim({ card }) || steeringHeld({ card })
      || activeCompaction({ card }) || ownerGates({ card }).length) {
      return []
    }

    return (card.steering ?? []).filter(message => message.source === 'dependency'
      && !message.ack && !message.attempts.length).map(message => ({
      card: card.id,
      message: message.id,
    }))
  })
  const ids = new Set(pending.map(item => item.message))

  for (const id of retryAfter.keys()) {
    if (!ids.has(id)) {
      retryAfter.delete(id)
    }
  }

  return pending.filter(item => now >= (retryAfter.get(item.message) ?? 0))
}

export function waitResumesPending({
  state,
  retryAfter,
  now = Date.now(),
}: {
  state: HydraState
  retryAfter: Map<string, number>
  now?: number
}): boolean {
  return unnotifiedResumes({
    state,
    retryAfter,
    now,
  }).length > 0
}

export async function notifyWaitResumes({
  hydraId,
  retryAfter,
  retryDelay,
  now = Date.now(),
}: {
  hydraId: string
  retryAfter: Map<string, number>
  retryDelay: number
  now?: number
}): Promise<void> {
  const pending = unnotifiedResumes({
    state: loadHydra({ hydraId }).state,
    retryAfter,
    now,
  })

  for (const item of pending) {
    retryAfter.set(
      item.message,
      now + retryDelay,
    )
    await notifySteering({
      hydraId,
      ...item,
      attempt: `initial:${item.message}`,
    })
    retryAfter.delete(item.message)
  }
}

function resumable({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): boolean {
  if (!card.wait || !liveTask({ card }) || card.status?.state !== 'paused'
    || steeringHeld({ card }) || activeCompaction({ card })
    || ownerGates({ card }).length || openAsks({ card }).length) {
    return false
  }

  if (activeHelperBatches({ state }).some(batch => batch.tasks.includes(card.id))) {
    return false
  }

  return taskReadiness({
    state,
    card,
  }).ready
}

export function resumeWaits({
  hydraId,
  state,
  at = new Date().toISOString(),
}: {
  hydraId: string
  state: HydraState
  at?: string
}): number {
  if (state.config?.hydra.kind === 'firstmate' || !Object.values(state.cards).some(card => resumable({
    state,
    card,
  }))) {
    return 0
  }

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      let resumed = 0

      for (const card of Object.values(writer.state.cards)) {
        if (!resumable({
          state: writer.state,
          card,
        }) || !card.wait) {
          continue
        }

        const wait = card.wait
        const ready = waitReadiness({
          state: writer.state,
          wait,
        })
        const title = clip({
          text: ready.title,
          size: RESUME_TITLE_CHARS,
        })
        const text = `Dependency ready: ${title} (${wait.task}), ${wait.condition}${ready.url ? `: ${ready.url}` : ''}. Continue your task.`
        const id = `wait-resume:${wait.id}`
        const message = {
          id,
          order: (card.steering?.at(-1)?.order ?? 0) + 1,
          text,
          source: 'dependency',
          at,
          actor: 'pnyx',
          queuedFor: steeringClaim({ card }),
          attempts: [],
        }
        writer.append({
          event: {
            ...base({
              state: writer.state,
              cardId: card.id,
              meta: {
                id,
                actor: 'pnyx',
                at,
              },
            }),
            type: 'task.wait-resumed',
            data: {
              wait: wait.id,
              message,
            },
          },
        })
        resumed++
      }

      return { resumed }
    },
  }).resumed
}
