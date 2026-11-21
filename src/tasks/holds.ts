import { inform } from '#app/command-notices.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from './push-rules.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from './model.ts'
import { askAnswer } from './ask-decide.ts'
import { openAsks } from './ask-state.ts'
import { isManagedTask } from './select.ts'
import { clarificationMessage } from './question-actions.ts'
import { holdBlocker } from './owner-gates.ts'

export function requireUnheld({ card }: { card: Card }): void {
  if (card.hold) {
    const blocker = holdBlocker({
      task: card.id,
      reason: card.hold.reason,
    })
    inform({
      task: card.id,
      reason: blocker.reason,
      clear: blocker.clear,
    })
  }
}

export function decideHold({
  state,
  ref,
  message,
  release,
  meta,
}: {
  state: HydraState
  ref: string
  message?: string
  release: boolean
  meta: Meta
}) {
  const card = findCard({
    state,
    ref,
  })

  if (isManagedTask({ card })) {
    throw new HydraError({
      message: 'hold a task card',
      code: 'VALIDATION_ERROR',
    })
  }

  if (!ownerActor({ actor: meta.actor }) && meta.actor !== HYDRA_ACTOR) {
    inform({
      reason: 'Discussion hold changed by an agent',
      clear: 'pnyx task release <task> --reason "<why>"',
      task: card.id,
    })
  }

  const reason = meta.reason?.trim() || `${release ? 'Release' : 'Discussion hold'} requested by ${meta.actor}`

  if (!meta.reason?.trim()) {
    inform({
      task: card.id,
      reason: 'No reason supplied; using the caller’s request',
      clear: `Use pnyx task hold ${card.id} --reason "<why>" to describe the hold`,
    })
  }

  if (!release) {
    return hydraEvent({
      state,
      meta,
      cardId: card.id,
      change: {
        type: 'task.held',
        data: { reason },
      },
    })
  }

  const source = state.hydraMessages?.find(entry => entry.id === message)

  if (message && !source) {
    throw new HydraError({
      message: 'Owner message not found',
      code: 'NOT_FOUND',
    })
  }

  if (!card.hold) {
    return { skipped: 'unchanged' as const }
  }

  const question = openAsks({ card }).find(ask => ask.kind === 'go' && ask.hold?.id === card.hold?.id)
  const askedAt = question?.reaskedAt ?? question?.escalated?.at ?? question?.at
  const ownerGo = source?.action === 'send' && ownerActor({ actor: source.actor })
    && Date.parse(source.at) > Date.parse(card.hold.at)
    && (askedAt === undefined || Date.parse(source.at) > Date.parse(askedAt))
    && !clarificationMessage({ message: source })

  if (!ownerGo) {
    inform({
      task: card.id,
      reason: 'Discussion hold released without an owner go message',
      clear: `Use pnyx task hold ${card.id} --reason "<why>" to restore it`,
    })
  }

  const recorded = source ? {
    id: source.id,
    text: source.text,
    at: source.at,
  } : {
    id: meta.id ?? `release:${state.seq + 1}`,
    text: reason,
    at: meta.at,
  }

  if (question) {
    askAnswer({
      state,
      card,
      id: question.id,
      actor: HYDRA_ACTOR,
      choice: 'Go',
      ...(ownerGo ? { fromMessage: source.id } : {}),
    })
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.released',
      data: {
        hold: card.hold.id,
        answers: question?.id,
        message: recorded,
        ...(!ownerGo ? { direct: true as const } : {}),
      },
    },
  })
}
