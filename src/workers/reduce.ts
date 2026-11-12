import type { HydraEvent, HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { refreshTasks } from '#tasks/columns.ts'
import { touch } from '#tasks/touch.ts'
import { applyAskChoice } from '#tasks/ask-reducer.ts'
import { applyAttachment, cardSessionId } from './session-attachments.ts'
import { requestId } from './answers.ts'
import type { Reply } from './model.ts'

export function applyDispatchProposal({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type === 'hydra.dispatch-proposed') {
    state.dispatchProposals = [
      ...(state.dispatchProposals ?? []).filter(p => p.token !== event.data.token),
      structuredClone(event.data),
    ]

    return true
  }

  if (event.type === 'hydra.dispatch-progress') {
    const proposal = state.dispatchProposals?.find(p => p.token === event.data.token)

    if (proposal) {
      proposal.status = event.data.status
      proposal.error = event.data.error
    }

    return true
  }

  if (event.type === 'hydra.dispatch-resolved') {
    state.dispatchProposals = (state.dispatchProposals ?? [])
      .filter(p => p.token !== event.data.token)

    return true
  }

  return false
}

export function applyLaunch({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type === 'task.launched' || event.type === 'task.copy') {
    const card = state.cards[event.cardId]

    if (card) {
      if (event.type === 'task.copy') {
        card.copy = structuredClone(event.data.after)
      } else {
        card.launch = structuredClone(event.data)
        const session = card.sessionIds?.[0] && state.sessions?.[card.sessionIds[0]]

        if (session) {
          session.launch = structuredClone(event.data)
        }
      }

      touch({
        card,
        event,
      })
    }

    return true
  }

  return false
}

export function applySessionMove({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  const card = state.cards[event.cardId]

  if (event.type === 'task.session') {
    const attached = state.sessions?.[event.data.session]?.taskId === event.data.before
    applyAttachment({
      state,
      event,
    })

    if (attached) {
      for (const id of [
        event.data.before,
        event.data.after,
      ]) {
        const task = id && state.cards[id]

        if (task) {
          task.steeringGeneration = event.seq
        }
      }
    }

    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    refreshTasks({
      state,
      ids: [
        event.cardId,
        event.data.before,
        event.data.after,
      ],
    })

    if (card && event.data.before !== card.id) {
      touch({
        card,
        event,
      })
    }

    return true
  }

  return false
}

export function applyReplyReceipt({
  state,
  card,
  event,
}: {
  state: HydraState
  card: Card
  event: Extract<HydraEvent, { type: 'card.replied' }>
}): void {
  const answers = event.data.answers
  const previous = card.replies?.find(r => r.id === event.data.reply)
  const taskMessage = event.data.taskMessage || previous?.route
  const resumes = event.data.resumes ?? previous?.resumes
  const reply: Reply = {
    id: event.data.reply,
    state: event.data.state,
    ...(resumes !== undefined ? { resumes } : {}),
    ...(taskMessage ? { route: event.data.route } : {}),
    ...(taskMessage && event.data.detail ? { detail: event.data.detail } : {}),
  }
  const decision = event.data.decision ?? previous?.decision
  const received = event.data.received ?? previous?.received

  if (received) {
    reply.received = received
  }

  if (event.data.accepted || previous?.accepted) {
    reply.accepted = true
    reply.text = event.data.text ?? previous?.text
    reply.context = event.data.context ?? previous?.context
  }

  if (decision) {
    reply.decision = decision
  }

  const kept = answers ? {
    ...reply,
    answers,
  } : reply
  const replies = card.replies ?? []
  card.replies = replies.some(r => r.id === reply.id)
    ? replies.map(r => (r.id === reply.id ? kept : r))
    : [
      ...replies,
      kept,
    ]

  // A task shows its session's requests, which hooks read back from the
  // session's own card, so the answer is marked on all of them.
  if (answers && event.data.state === 'delivered') {
    // Lifts no hold: a go question is always Hydra's, and an answer to Hydra's question arrives as a Hydra message, which applyAsk handles.
    if (card.asks && !reply.accepted) {
      card.asks = card.asks.map(ask => {
        const sameRound = ask.answerRound === decision?.answerRound

        if (ask.id !== answers || !sameRound || ask.answered || ask.closed) {
          return ask
        }

        const answered = {
          ...ask,
          answered: reply.id,
          answeredAt: event.at,
          fromMessage: decision?.fromMessage,
        }
        applyAskChoice({
          ask: answered,
          choice: decision?.choice,
          answer: decision?.answer,
        })

        return answered
      })
    }

    const id = cardSessionId({ card })
    const session = id ? state.sessions?.[id] : undefined
    const origin = session && state.cards[session.originCardId]
    const task = session?.taskId ? state.cards[session.taskId] : undefined

    for (const holder of new Set([
      card,
      session,
      origin,
      task,
    ])) {
      if (holder) {
        holder.attention = holder.attention
          .map(a => (requestId({ request: a }) === answers ? {
            ...a,
            answered: reply.id,
          } : a))
      }
    }
  }
}
