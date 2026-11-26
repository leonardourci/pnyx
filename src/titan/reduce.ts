import { cloneValue } from '#app/json-copy.ts'
import { recordTitanTurn } from '#workers/session-facts.ts'
import { ownerActor } from '#app/actors.ts'
import type { TitanEvent, TitanState } from '#app/model.ts'
import { refreshTasks } from '#tasks/refresh.ts'
import { touch } from '#tasks/touch.ts'
import { operationLabel } from './operation-label.ts'
import { TITAN_CARD } from './identity.ts'
import { titanConfig } from './config.ts'

export function applyTitan({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): boolean {
  if (event.type === 'titan.agent-used') {
    state.titanAgent = structuredClone(event.data)

    return true
  }

  if (event.type === 'titan.delivered') {
    const session = state.sessions?.[event.data.session]

    if (session) {
      recordTitanTurn({
        session,
        event,
      })
    }

    return true
  }

  if (event.type === 'titan.agent-change') {
    const change = event.data

    if (change.state === 'finished') {
      delete state.titanAgentChange
      state.titanAgent = structuredClone(change.next)

      if (change.summary !== undefined) {
        state.titanContext = {
          after: event.seq,
          summary: change.summary,
          previousSession: change.previousSession,
        }
      }

      if (change.kind === 'agent') {
        state.titanMessages = [
          ...(state.titanMessages ?? []),
          {
            id: event.id,
            action: 'send',
            kind: 'divider',
            text: `Switched to ${change.next.model ?? change.next.harness}`,
            at: event.at,
            actor: 'othrys',
            titan: titanConfig({ state }).titan.id,
          },
        ]
      }
    } else if (change.state === 'cancelled') {
      delete state.titanAgentChange
    } else {
      state.titanAgentChange = structuredClone(change)
    }

    return true
  }

  if (event.type === 'titan.operation') {
    if (event.data.kind === 'inscribe' || event.data.blocking === false) {
      return true
    }

    if (event.data.state === 'started') {
      state.titanOperation = {
        id: event.data.id,
        kind: event.data.kind,
        since: event.at,
        seq: event.data.after ?? event.seq,
      }
    } else if (state.titanOperation?.id === event.data.id) {
      delete state.titanOperation

      // A compaction and an upgrade draw their own milestone lines.
      if (event.data.kind === 'compaction' || event.data.kind === 'upgrade') {
        return true
      }

      state.titanMessages = [
        ...(state.titanMessages ?? []),
        {
          id: event.id,
          action: 'send',
          kind: 'divider',
          text: operationLabel(event.data),
          at: event.at,
          actor: 'othrys',
          // The chat shows the messages of the Titan it is configured as.
          titan: titanConfig({ state }).titan.id,
        },
      ]
    }

    return true
  }

  if (event.type === 'titan.input-stopped') {
    for (const message of state.titanMessages ?? []) {
      if (event.data.messages.includes(message.id) && !message.received) {
        message.stopped = true
      }
    }

    return true
  }

  if (event.type === 'titan.input') {
    const message = state.titanMessages?.find(item => item.id === event.data.message)

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

  if (event.type === 'titan.received') {
    const message = state.titanMessages?.find(item => item.id === event.data.message)

    if (message) {
      message.received = event.data.at
      delete message.stopped
      delete message.failure
    }

    return true
  }

  if (event.type === 'titan.status') {
    state.titanStatus = {
      ...structuredClone(event.data),
      seq: event.seq,
    }

    return true
  }

  if (event.type === 'titan.review') {
    const reminders = { ...state.titanReview?.reminders }

    for (const key of event.data.reminders) {
      reminders[key] = event.at
    }

    state.titanReview = {
      at: event.at,
      seq: event.seq,
      block: event.data.block,
      reminders,
      flags: event.data.flags,
    }

    return true
  }

  if (event.type === 'titan.configured') {
    state.config = structuredClone(event.data)
    Reflect.deleteProperty(
      state.config,
      'readPoleis',
    )
    state.configured = true
    const session = event.data.titan.session

    if (session && event.id.endsWith(':hosted')) {
      const observed = state.sessions?.[session]

      if (observed) {
        recordTitanTurn({
          session: observed,
          event,
        })
      }
    }

    if (session && !state.titanSessions?.includes(session)) {
      state.titanSessions = [
        ...state.titanSessions ?? [],
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
    const titan = state.cards[TITAN_CARD]!
    titan.title = event.data.titan.name
    titan.hidden = true
    state.keys[TITAN_CARD] = TITAN_CARD
    refreshTasks({ state })

    return true
  }

  // Kinds are Titan settings; saving one does not choose the Titan.
  if (event.type === 'titan.agents') {
    state.config = cloneValue({
      value: titanConfig({
        state,
        id: event.titanId,
      }),
    })
    state.config.agents = structuredClone(event.data.agents)
    state.configRevision = (state.configRevision ?? 0) + 1

    return true
  }

  if (event.type === 'titan.message') {
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
    state.titanMessages = [
      ...(state.titanMessages ?? []),
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
