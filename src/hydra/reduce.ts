import { cloneValue } from '#app/preimage.ts'
import { ownerActor } from '#app/actors.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { refreshTasks } from '#tasks/columns.ts'
import { touch } from '#tasks/touch.ts'
import { operationLabel } from './operation-label.ts'
import { HYDRA_CARD } from './identity.ts'
import { hydraConfig } from './config.ts'

export function applyHydra({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type === 'hydra.agent-used') {
    state.hydraAgent = structuredClone(event.data)

    return true
  }

  if (event.type === 'hydra.delivered') {
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
          // The chat shows the messages of the Hydra it is configured as.
          hydra: hydraConfig({ state }).hydra.id,
        },
      ]
    }

    return true
  }

  if (event.type === 'hydra.input-cancelled') {
    for (const message of state.hydraMessages ?? []) {
      if (event.data.messages.includes(message.id) && !message.received) {
        message.stopped = true
      }
    }

    return true
  }

  if (event.type === 'hydra.received') {
    const message = state.hydraMessages?.find(item => item.id === event.data.message)

    if (message) {
      message.received = event.data.at
      delete message.stopped
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
    state.configured = true
    const session = event.data.hydra.session

    if (session && !state.hydraSessions?.includes(session)) {
      state.hydraSessions = [
        ...state.hydraSessions ?? [],
        session,
      ]
    }

    state.configRevision = (state.configRevision ?? 0) + 1
    state.cards[HYDRA_CARD] ??= {
      id: HYDRA_CARD,
      key: HYDRA_CARD,
      title: 'Hydra',
      workspace: 'unassigned',
      tags: [],
      attention: [],
      links: [],
      sourceRefs: [],
      hidden: true,
      column: 'parked',
      revision: 0,
      createdSeq: event.seq,
      updatedSeq: event.seq,
      updatedAt: event.at,
    }
    const hydra = state.cards[HYDRA_CARD]!
    hydra.title = event.data.hydra.name
    hydra.hidden = true
    state.keys[HYDRA_CARD] = HYDRA_CARD
    refreshTasks({ state })

    return true
  }

  // Kinds are Hydra settings; saving one does not choose the Hydra.
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

  if (event.type === 'board.columns') {
    state.config = cloneValue({
      value: hydraConfig({
        state,
        id: event.boardId,
      }),
    })
    state.config.columns = structuredClone(event.data.columns)
    state.configRevision = (state.configRevision ?? 0) + 1

    for (const card of Object.values(state.cards)) {
      const placement = event.data.placements?.[card.id]

      if (placement?.after) {
        card.column = placement.after
      }

      if (!event.data.columns.some(c => c.id === card.column)) {
        card.column = event.data.fallback ?? event.data.columns[0]!.id
      }

      if (placement) {
        touch({
          card,
          event,
        })
      }
    }

    refreshTasks({ state })

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
      } else if (event.data.kind === 'progress') {
        card.progress = {
          text: event.data.text,
          at: event.at,
          actor: event.actor,
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
