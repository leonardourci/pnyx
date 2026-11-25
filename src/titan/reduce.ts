import { cloneValue } from '#app/json-copy.ts'
import { recordTitanTurn } from '#workers/session-facts.ts'
import { ownerActor } from '#app/actors.ts'
import type { TitanEvent, TitanState } from '#app/model.ts'
import { refreshTasks } from '#tasks/refresh.ts'
import { touch } from '#tasks/touch.ts'
import { operationLabel } from './operation-label.ts'
import { TITAN_CARD } from './identity.ts'
import { hydraConfig } from './config.ts'

export function applyTitan({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): boolean {
  if (event.type === 'hydra.agent-used') {
    state.hydraAgent = structuredClone(event.data)

    return true
  }

  if (event.type === 'hydra.delivered') {
    const session = state.sessions?.[event.data.session]

    if (session) {
      recordTitanTurn({
        session,
        event,
      })
    }

    return true
  }

  if (event.type === 'hydra.agent-change') {
    const change = event.data

    if (change.state === 'finished') {
      delete state.hydraAgentChange
      state.hydraAgent = structuredClone(change.next)

      if (change.summary !== undefined) {
        state.hydraContext = {
          after: event.seq,
          summary: change.summary,
          previousSession: change.previousSession,
        }
      }

      if (change.kind === 'agent') {
        state.hydraMessages = [
          ...(state.hydraMessages ?? []),
          {
            id: event.id,
            action: 'send',
            kind: 'divider',
            text: `Switched to ${change.next.model ?? change.next.harness}`,
            at: event.at,
            actor: 'pnyx',
            hydra: hydraConfig({ state }).hydra.id,
          },
        ]
      }
    } else if (change.state === 'cancelled') {
      delete state.hydraAgentChange
    } else {
      state.hydraAgentChange = structuredClone(change)
    }

    return true
  }

  if (event.type === 'hydra.operation') {
    if (event.data.kind === 'inscribe' || event.data.blocking === false) {
      return true
    }

    if (event.data.state === 'started') {
      state.hydraOperation = {
        id: event.data.id,
        kind: event.data.kind,
        since: event.at,
        seq: event.data.after ?? event.seq,
      }
    } else if (state.hydraOperation?.id === event.data.id) {
      delete state.hydraOperation

      // A compaction and an upgrade draw their own milestone lines.
      if (event.data.kind === 'compaction' || event.data.kind === 'upgrade') {
        return true
      }

      state.hydraMessages = [
        ...(state.hydraMessages ?? []),
        {
          id: event.id,
          action: 'send',
          kind: 'divider',
          text: operationLabel(event.data),
          at: event.at,
          actor: 'pnyx',
          // The chat shows the messages of the Titan it is configured as.
          hydra: hydraConfig({ state }).hydra.id,
        },
      ]
    }

    return true
  }

  if (event.type === 'hydra.input-stopped') {
    for (const message of state.hydraMessages ?? []) {
      if (event.data.messages.includes(message.id) && !message.received) {
        message.stopped = true
      }
    }

    return true
  }

  if (event.type === 'hydra.input') {
    const message = state.hydraMessages?.find(item => item.id === event.data.message)

    if (message && !message.received) {
      if (event.data.state === 'failed') {
        message.failure = event.data.error
      } else {
        message.attempt = (message.attempt ?? 0) + 1
        delete message.failure
      }
    }

    return true
  }

  if (event.type === 'hydra.received') {
    const message = state.hydraMessages?.find(item => item.id === event.data.message)

    if (message) {
      message.received = event.data.at
      delete message.stopped
      delete message.failure
    }

    return true
  }

  if (event.type === 'hydra.status') {
    state.hydraStatus = {
      ...structuredClone(event.data),
      seq: event.seq,
    }

    return true
  }

  if (event.type === 'hydra.review') {
    const reminders = { ...state.hydraReview?.reminders }

    for (const key of event.data.reminders) {
      reminders[key] = event.at
    }

    state.hydraReview = {
      at: event.at,
      seq: event.seq,
      block: event.data.block,
      reminders,
      flags: event.data.flags,
    }

    return true
  }

  if (event.type === 'board.configured') {
    state.config = structuredClone(event.data)
    Reflect.deleteProperty(
      state.config,
      'readPoleis',
    )
    state.configured = true
    const session = event.data.hydra.session

    if (session && event.id.endsWith(':hosted')) {
      const observed = state.sessions?.[session]

      if (observed) {
        recordTitanTurn({
          session: observed,
          event,
        })
      }
    }

    if (session && !state.hydraSessions?.includes(session)) {
      state.hydraSessions = [
        ...state.hydraSessions ?? [],
        session,
      ]
    }

    state.configRevision = (state.configRevision ?? 0) + 1
    state.cards[TITAN_CARD] ??= {
      id: TITAN_CARD,
      key: TITAN_CARD,
      title: 'Titan',
      workspace: 'unassigned',
      tags: [],
      attention: [],
      links: [],
      sourceRefs: [],
      hidden: true,
      revision: 0,
      createdSeq: event.seq,
      updatedSeq: event.seq,
      updatedAt: event.at,
    }
    const hydra = state.cards[TITAN_CARD]!
    hydra.title = event.data.hydra.name
    hydra.hidden = true
    state.keys[TITAN_CARD] = TITAN_CARD
    refreshTasks({ state })

    return true
  }

  // Kinds are Titan settings; saving one does not choose the Titan.
  if (event.type === 'board.agents') {
    state.config = cloneValue({
      value: hydraConfig({
        state,
        id: event.boardId,
      }),
    })
    state.config.agents = structuredClone(event.data.agents)
    state.configRevision = (state.configRevision ?? 0) + 1

    return true
  }

  if (event.type === 'hydra.message') {
    if (event.data.reminderQuestions) {
      const reminders = { ...state.questionReminders }

      for (const key of event.data.reminderQuestions) {
        reminders[key] = event.at
      }

      state.questionReminders = reminders
    }

    const message = {
      ...event.data,
      id: event.id,
      at: event.at,
      actor: event.actor,
    }
    state.hydraMessages = [
      ...(state.hydraMessages ?? []),
      message,
    ]
    const card = event.data.task ? state.cards[event.data.task] : undefined

    if (card) {
      if (ownerActor({ actor: event.actor })) {
        card.ask = [
          ...(card.ask ?? []),
          {
            text: event.data.text,
            at: event.at,
            actor: event.actor,
            message: event.id,
          },
        ]
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
