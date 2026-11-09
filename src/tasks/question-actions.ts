import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { HydraError } from '#store/errors.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { hydraConfig } from '#hydra/config.ts'
import { findCard } from './push-rules.ts'
import { openAsks, pendingAnswer } from './ask-state.ts'
import { reminderTime } from './time.ts'
import type { AnswerMessage } from './model.ts'
import type { HydraMessage } from '#hydra/model.ts'

export function clarificationText({ text }: { text: string }): boolean {
  const value = text.trim()
  const shortRequest = /^(?:why|(?:please\s+)?(?:explain|clarify)|(?:can|could|would) you (?:please )?(?:explain|clarify)|help me understand|what do you mean|tell me more)[.!?]*$/i.test(value)
  const startsClarification = /^(?:why\b|(?:please\s+)?(?:explain|clarify)\b|(?:can|could|would) you (?:please )?(?:explain|clarify)\b|help me understand\b|what do you mean\b|tell me more\b)/i.test(value)

  return shortRequest || (value.endsWith('?') && startsClarification)
}

export const clarificationMessage = ({ message }: { message: Pick<HydraMessage, 'text' | 'discusses'> }) =>
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
  state: HydraState
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
    throw new HydraError({
      code: 'ASK_CLOSED',
      message: 'This question is not waiting for the owner',
    })
  }

  let source: AnswerMessage | undefined

  if (fromMessage) {
    const message = state.hydraMessages?.find(message => message.id === fromMessage)
    const askedAt = ask.reaskedAt ?? ask.escalated?.at ?? ask.at
    const newer = message && Date.parse(message.at) > Date.parse(askedAt)

    if (meta.actor !== HYDRA_ACTOR || !message || !ownerActor({ actor: message.actor })
      || message.action !== 'send' || !newer || clarificationMessage({ message })) {
      throw new HydraError({
        code: 'OWNER_ONLY',
        message: 'Deferral requires the owner’s own newer message',
      })
    }

    source = {
      id: message.id,
      text: message.text,
      at: message.at,
    }
  }

  if (!ownerActor({ actor: meta.actor }) && !source) {
    throw new HydraError({
      code: 'OWNER_ONLY',
      message: 'Only the owner can defer or discuss their question',
    })
  }

  if (until !== undefined) {
    if (pendingAnswer({
      card,
      ask,
    })) {
      throw new HydraError({
        code: 'SESSION_WAITING',
        message: 'Check the pending answer before deferring this question',
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

  if (!discussion || !ownerActor({ actor: meta.actor })) {
    throw new HydraError({
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
