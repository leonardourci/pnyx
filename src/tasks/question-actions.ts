import { inform } from '#app/command-notices.ts'
import { ownerActor } from '#app/actors.ts'
import type { TitanState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { TitanError } from '#store/errors.ts'
import { hydraEvent } from '#titan/titan.ts'
import { hydraConfig } from '#titan/config.ts'
import { findCard } from './push-rules.ts'
import { openAsks, pendingAnswer } from './ask-state.ts'
import { reminderTime } from './time.ts'
import type { AnswerMessage } from './model.ts'
import type { TitanMessage } from '#titan/model.ts'

export function clarificationText({ text }: { text: string }): boolean {
  const value = text.trim()
  const shortRequest = /^(?:why|(?:please\s+)?(?:explain|clarify)|(?:can|could|would) you (?:please )?(?:explain|clarify)|help me understand|what do you mean|tell me more)[.!?]*$/i.test(value)
  const startsClarification = /^(?:why\b|(?:please\s+)?(?:explain|clarify)\b|(?:can|could|would) you (?:please )?(?:explain|clarify)\b|help me understand\b|what do you mean\b|tell me more\b)/i.test(value)

  return shortRequest || (value.endsWith('?') && startsClarification)
}

export const clarificationMessage = ({ message }: { message: Pick<TitanMessage, 'text' | 'discusses'> }) =>
  !!message.discusses || clarificationText({ text: message.text })

export function decideQuestionAction({
  state,
  ref,
  id,
  until,
  text,
  fromMessage,
  meta,
}: {
  state: TitanState
  ref: string
  id: string
  until?: string
  text?: string
  fromMessage?: string
  meta: Meta
}) {
  const card = findCard({
    state,
    ref,
  })
  const ask = openAsks({
    card,
    audience: 'owner',
  }).find(ask => ask.id === id)

  if (!ask) {
    throw new TitanError({
      code: 'ASK_CLOSED',
      message: 'This question is not waiting for the owner',
    })
  }

  let source: AnswerMessage | undefined

  if (fromMessage) {
    const message = state.hydraMessages?.find(message => message.id === fromMessage)
    const askedAt = ask.reaskedAt ?? ask.escalated?.at ?? ask.at
    const newer = message && Date.parse(message.at) > Date.parse(askedAt)

    if (!message) {
      throw new TitanError({
        message: 'Saved message not found',
        code: 'NOT_FOUND',
      })
    }

    const ownerMessage = ownerActor({ actor: message.actor }) && message.action === 'send'

    if (ownerMessage && newer && !clarificationMessage({ message })) {
      source = {
        id: message.id,
        text: message.text,
        at: message.at,
      }
    } else {
      inform({
        task: card.id,
        reason: 'Deferred a question without a newer owner instruction',
        clear: `Review the deferral of question ${id} on task ${card.id} in the UI.`,
      })
    }
  }

  if (!ownerActor({ actor: meta.actor }) && !source) {
    inform({
      task: card.id,
      reason: 'Owner question deferred or discussed by an agent',
      clear: `Review the deferral of question ${id} on task ${card.id} in the UI.`,
    })
  }

  if (until !== undefined) {
    if (pendingAnswer({
      card,
      ask,
    })) {
      inform({
        task: card.id,
        reason: 'An answer is already being delivered while this question is deferred',
        clear: `Read tasks/${card.id}/task.log to inspect its delivery`,
      })
    }

    return hydraEvent({
      state,
      cardId: card.id,
      meta,
      change: {
        type: 'task.ask.deferred',
        data: {
          ask: id,
          until: until === 'clear' ? null : reminderTime({
            when: until,
            now: meta.at,
          }),
          fromMessage: source,
        },
      },
    })
  }

  const discussion = text?.trim()

  if (!discussion) {
    throw new TitanError({
      code: 'VALIDATION_ERROR',
      message: 'Discuss a question with the owner’s own --text',
    })
  }

  return hydraEvent({
    state,
    cardId: card.id,
    meta,
    change: {
      type: 'hydra.message',
      data: {
        hydra: hydraConfig({ state }).hydra.id,
        task: card.id,
        discusses: ask.id,
        action: 'send',
        text: discussion,
        context: `Clarification on question ${id}: ${ask.question}. The question remains open; this is not an answer.`,
      },
    },
  })
}
