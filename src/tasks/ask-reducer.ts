import { cloneValue } from '#app/preimage.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { AnswerMessage, Ask } from './model.ts'
import { touch } from './touch.ts'

export function applyAskChoice({
  ask,
  choice,
  answer,
}: {
  ask: Ask
  choice?: string
  answer?: string
}): void {
  if (choice !== undefined) {
    ask.choice = choice
  } else if ((ask.kind === 'merge' || ask.kind === 'go') && answer !== undefined) {
    ask.choice = answer
  }
}

export function applyAsk({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  let acceptance: {
    card: string
    ask: string
    answer: string
    choice?: string
    source?: AnswerMessage
    id: string
  } | undefined

  if (event.type === 'hydra.message' && event.data.answers && event.data.task) {
    acceptance = {
      card: event.data.task,
      ask: event.data.answers,
      answer: event.data.text,
      choice: event.data.choice,
      source: event.data.fromMessage,
      id: event.id,
    }
  } else if (event.type === 'card.replied' && event.data.accepted && event.data.text !== undefined
    && event.data.answers && event.data.decision) {
    acceptance = {
      card: event.cardId,
      ask: event.data.answers,
      answer: event.data.decision.answer,
      choice: event.data.decision.choice,
      source: event.data.decision.fromMessage,
      id: event.data.reply,
    }
  } else if (event.type === 'task.released' && event.data.answers) {
    acceptance = {
      card: event.cardId,
      ask: event.data.answers,
      answer: event.data.message.text,
      choice: 'Go',
      source: event.data.message,
      id: event.id,
    }
  }

  if (acceptance) {
    const accepted = acceptance
    const card = state.cards[accepted.card]

    if (card?.asks) {
      card.asks = card.asks.map(ask => {
        if (ask.id !== accepted.ask) {
          return ask
        }

        const answered = {
          ...ask,
          answered: accepted.id,
          answeredAt: event.at,
          fromMessage: accepted.source,
        }

        // The owner already said it in chat, and a Hydra-wide question has no task to finish, so it closes here.
        if (accepted.card === HYDRA_CARD && accepted.source) {
          answered.closed = {
            id: accepted.id,
            at: event.at,
            reason: 'answered from your message',
            evidence: accepted.source.id,
          }
        }

        if (ask.kind === 'merge' && ask.choice === 'Hold' && ask.answered) {
          answered.mergeHold = {
            answered: ask.answered,
            answeredAt: ask.answeredAt,
            fromMessage: ask.fromMessage,
            choice: ask.choice,
          }
        }

        applyAskChoice({
          ask: answered,
          choice: accepted.choice,
          answer: accepted.answer,
        })

        if (ask.kind === 'go' && answered.choice === 'Go' && card.hold?.id === ask.hold?.id) {
          delete card.hold
        }

        return answered
      })
    }
  }

  if (event.type !== 'task.asked' && event.type !== 'task.ask.escalated'
    && event.type !== 'task.ask.closed' && event.type !== 'task.ask.reopened' && event.type !== 'task.ask.deferred') {
    return false
  }

  const card = state.cards[event.cardId]

  if (!card) {
    return true
  }

  if (event.type === 'task.asked') {
    if (!card.asks?.some(a => a.id === event.data.id)) {
      card.asks = [
        ...(card.asks ?? []),
        {
          ...structuredClone(event.data),
          at: event.at,
          actor: event.actor,
        },
      ]
    }
  } else if (event.type === 'task.ask.deferred' && card.asks) {
    card.asks = card.asks.map(ask => {
      if (ask.id !== event.data.ask || ask.audience !== 'owner' || ask.answered || ask.closed) {
        return ask
      }

      const deferred = { ...ask }
      delete deferred.deferredUntil
      delete deferred.deferredFromMessage

      if (event.data.until) {
        deferred.deferredUntil = event.data.until
        deferred.deferredFromMessage = event.data.fromMessage
      }

      return deferred
    })
  } else if (event.type === 'task.ask.closed' && card.asks) {
    card.asks = card.asks.map(a => a.id === event.data.ask ? {
      ...a,
      closed: {
        id: event.id,
        at: event.at,
        reason: event.data.reason,
        evidence: event.data.evidence,
      },
    } : a)
  } else if (event.type === 'task.ask.reopened' && card.asks) {
    card.asks = card.asks.map(a => {
      if (a.id !== event.data.ask || a.answered !== event.data.answer) {
        return a
      }

      if (a.kind === 'go' && a.choice === 'Go' && a.hold && !card.hold) {
        card.hold = cloneValue({ value: a.hold })
      }

      const reopened = { ...a }

      if (reopened.deferredUntil && Date.parse(reopened.deferredUntil) <= Date.parse(event.at)) {
        delete reopened.deferredUntil
        delete reopened.deferredFromMessage
      }

      if (event.data.reask) {
        reopened.mergeHold = {
          answered: a.answered,
          answeredAt: a.answeredAt,
          fromMessage: a.fromMessage,
          choice: a.choice,
        }
        reopened.reaskedAt = event.at
        reopened.answerRound = event.id
      } else if (a.mergeHold) {
        delete reopened.fromMessage
        Object.assign(
          reopened,
          a.mergeHold,
        )

        if (!reopened.fromMessage) {
          delete reopened.fromMessage
        }

        delete reopened.mergeHold
        delete reopened.reaskedAt
        delete reopened.answerRound

        return reopened
      }

      delete reopened.answered
      delete reopened.answeredAt
      delete reopened.fromMessage
      delete reopened.choice

      return reopened
    })
  } else if (event.type === 'task.ask.escalated' && card.asks) {
    card.asks = card.asks.map(a => (a.id === event.data.ask ? {
      ...a,
      audience: 'owner',
      escalated: {
        id: event.id,
        at: event.at,
        actor: event.actor,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.data.question ? { question: event.data.question } : {}),
        ...(event.data.context ? { context: event.data.context } : {}),
      },
    } : a))
  }

  touch({
    card,
    event,
  })

  return true
}
