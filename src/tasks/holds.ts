import { inform } from '#app/command-notices.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from './push-rules.ts'
import { titanEvent } from '#titan/titan.ts'
import { TITAN_ACTOR, ownerActor } from '#app/actors.ts'
import type { TitanState } from '#app/model.ts'
import { TitanError } from '#store/errors.ts'
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
  state: TitanState
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
    throw new TitanError({
      message: 'hold a task card',
      code: 'VALIDATION_ERROR',
    })
  }

  if (!ownerActor({ actor: meta.actor }) && meta.actor !== TITAN_ACTOR) {
    inform({
      reason: 'Discussion hold changed by an agent',
      clear: 'Review the discussion hold for this task in the UI.',
      task: card.id,
    })
  }

  const reason = meta.reason?.trim() || `${release ? 'Release' : 'Discussion hold'} requested by ${meta.actor}`

  if (!meta.reason?.trim()) {
    inform({
      task: card.id,
      reason: 'No reason supplied; using the caller’s request',
      clear: `Describe the discussion hold for task ${card.id} in the UI.`,
    })
  }

  if (!release) {
    return titanEvent({
      state,
      meta,
      cardId: card.id,
      change: {
        type: 'task.held',
        data: { reason },
      },
    })
  }

  const source = state.titanMessages?.find(entry => entry.id === message)

  if (message && !source) {
    throw new TitanError({
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
      clear: `Review whether task ${card.id} should remain held in the UI.`,
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
      actor: TITAN_ACTOR,
      choice: 'Go',
      ...(ownerGo ? { fromMessage: source.id } : {}),
    })
  }

  return titanEvent({
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
