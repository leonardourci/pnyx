import type { HydraEvent, HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { refreshTasks } from './columns.ts'
import { createdColumn, roleColumn, ROLE_STATUS } from './column-rules.ts'
import { touch } from './touch.ts'

export function applyTask({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type === 'task.held' || event.type === 'task.released') {
    const card = state.cards[event.cardId]

    if (card) {
      if (event.type === 'task.held') {
        card.hold = {
          id: event.id,
          at: event.at,
          actor: event.actor,
          reason: event.data.reason,
        }
      } else if (card.hold?.id === event.data.hold) {
        delete card.hold
      }

      touch({
        card,
        event,
      })
    }

    return true
  }

  if (event.type === 'task.owner-ask' || event.type === 'task.intent') {
    const card = state.cards[event.cardId]

    if (card) {
      card.ask = [
        ...(card.ask ?? []),
        structuredClone(event.data),
      ]
      touch({
        card,
        event,
      })
    }

    return true
  }

  if (event.type === 'task.brief' || event.type === 'task.visibility' || event.type === 'task.retention') {
    const card = state.cards[event.cardId]

    if (card) {
      if (event.type === 'task.brief') {
        card.brief = event.data.after

        if (event.data.intent) {
          card.intent = event.data.intent
        }
      } else if (event.type === 'task.retention') {
        if (event.data.after === null) {
          delete card.doneAfterHours
        } else {
          card.doneAfterHours = event.data.after
        }

        delete card.keepDone
      } else {
        card.hidden = event.data.after

        if (event.data.automatic) {
          card.expired = true
        } else {
          delete card.expired

          if (!event.data.after && card.doneAt) {
            card.keepDone = true
          }
        }
      }

      touch({
        card,
        event,
      })
    }

    return true
  }

  if (event.type === 'task.created') {
    const {
      key,
      title,
      project,
      brief,
      parentId,
      column,
      folder,
      kind,
    } = event.data
    const columns = hydraConfig({ state }).columns
    let placement = column

    if (event.data.hold) {
      placement = roleColumn({
        columns,
        role: 'queued',
      })
    }

    const role = columns.find(c => c.id === placement)?.role
    const initial = role && ROLE_STATUS[role] && {
      id: event.id,
      at: event.at,
      actor: event.actor,
      state: ROLE_STATUS[role],
      note: '',
    }
    state.cards[event.cardId] = {
      id: event.cardId,
      key,
      title,
      ...(project ? { project } : {}),
      ...(brief !== undefined ? {
        brief,
        initialPrompt: brief,
      } : {}),
      ...(event.data.hold ? {
        hold: {
          id: event.id,
          at: event.at,
          actor: event.actor,
          reason: event.data.hold,
        },
      } : {}),
      ask: event.data.ask ? [structuredClone(event.data.ask)] : [],
      titleSet: true,
      workspace: 'unassigned',
      tags: [],
      attention: [],
      links: [],
      sourceRefs: [],
      sessionIds: [],
      tracking: 'declared',
      statusLog: initial ? [initial] : [],
      ...(initial ? { status: initial } : {}),
      ...(parentId ? { parentId } : {}),
      ...(folder ? { folder } : {}),
      column: createdColumn({
        columns,
        column,
        held: Boolean(event.data.hold),
      }),
      revision: 1,
      createdSeq: event.seq,
      updatedSeq: event.seq,
      updatedAt: event.at,
    }

    if (kind === 'investigation') {
      state.cards[event.cardId]!.kind = kind
    }

    if (event.data.intent) {
      state.cards[event.cardId]!.intent = event.data.intent
    }

    state.keys[key] = event.cardId
    refreshTasks({
      state,
      ids: [event.cardId],
    })

    return true
  }

  if (event.type === 'task.kind' || event.type === 'task.report' || event.type === 'task.report-reviewed' || event.type === 'task.landing') {
    const card = state.cards[event.cardId]

    if (!card) {
      return true
    }

    if (event.type === 'task.kind') {
      card.kind = event.data.after
    }

    if (event.type === 'task.report') {
      card.report = {
        id: event.id,
        at: event.at,
        actor: event.actor,
        chars: event.data.text.length,
      }
    }

    if (event.type === 'task.report-reviewed' && card.report?.id === event.data.report) {
      card.report.review = {
        id: event.id,
        at: event.at,
        actor: event.actor,
        calls: structuredClone(event.data.calls),
      }
    }

    if (event.type === 'task.landing' && event.data.after) {
      card.landing = event.data.after
    }

    if (event.type === 'task.landing' && !event.data.after) {
      delete card.landing
    }

    touch({
      card,
      event,
    })

    return true
  }

  if (event.type === 'task.declared' || event.type === 'task.mirrored') {
    const card = state.cards[event.cardId]

    if (card) {
      card.tracking = 'declared'

      if (event.type === 'task.declared') {
        const declaration = {
          ...event.data,
          id: event.id,
          at: event.at,
          actor: event.actor,
        }
        card.statusLog = [
          ...(card.statusLog ?? []),
          declaration,
        ]
        card.status = declaration
      } else {
        card.mirror = structuredClone(event.data)
      }

      touch({
        card,
        event,
      })
      refreshTasks({
        state,
        ids: [card.id],
      })
    }

    return true
  }

  return false
}
