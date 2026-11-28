import type { TitanEvent, TitanState } from '#app/model.ts'
import { refreshTasks } from './refresh.ts'
import { touch } from './touch.ts'
import { applySteering } from '#workers/steering.ts'
import { doneSince } from '#tasks/delivery/model.ts'

export function applyTask({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): boolean {
  if (event.type === 'task.branch') {
    const card = state.cards[event.cardId]

    const recorded = card?.branches?.some(branch => branch.repository === event.data.repository
      && branch.branch === event.data.branch)

    if (card && !recorded) {
      card.branches = [
        ...card.branches ?? [],
        { ...event.data },
      ]
      touch({
        card,
        event,
      })
    }

    return true
  }

  if (event.type === 'task.worker-log') {
    const workerLog = state.cards[event.cardId]?.workerLog

    if (workerLog) {
      workerLog.latest = {
        ...workerLog.latest,
        ...event.data,
      }
    }

    return true
  }

  if (event.type === 'task.worker-line') {
    const card = state.cards[event.cardId]

    if (card) {
      const latest = {
        ...event.data,
        at: event.at,
      }
      const changesStatus = [
        'needs-you',
        'blocked',
        'done',
      ].includes(latest.code)
      card.workerLog = {
        latest,
        status: changesStatus ? latest : card.workerLog?.status,
      }

      if (latest.code === 'needs-you' && !card.asks?.some(ask => ask.id === event.id)) {
        card.asks = [
          ...(card.asks ?? []),
          {
            id: event.id,
            at: event.at,
            actor: event.actor,
            audience: 'titan',
            question: latest.text,
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

  if (event.type === 'task.tools-applied') {
    const card = state.cards[event.cardId]

    if (card?.toolsRevision === event.data.revision) {
      card.toolsApplied = event.data.revision
      touch({
        card,
        event,
      })
    }

    return true
  }

  if (event.type === 'task.tools') {
    const card = state.cards[event.cardId]

    if (card) {
      card.tools = [...event.data.after]
      card.toolsRevision = event.id
      touch({
        card,
        event,
      })
    }

    return true
  }

  if (event.type === 'task.wait-resumed') {
    const card = state.cards[event.cardId]

    if (card?.wait?.id !== event.data.wait) {
      return true
    }

    applySteering({
      state,
      event: {
        ...event,
        type: 'task.steering.queued',
        data: { message: event.data.message },
      },
    })

    delete card.wait

    return true
  }

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

          if (!event.data.after && doneSince({ card })) {
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
      folder,
    } = event.data

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
      ...(parentId ? { parentId } : {}),
      ...(folder ? { folder } : {}),
      ...(event.data.workerLogDir ? { workerLogDir: event.data.workerLogDir } : {}),
      revision: 1,
      createdSeq: event.seq,
      createdAt: event.at,
      updatedSeq: event.seq,
      updatedAt: event.at,
    }

    if (event.data.rank !== undefined) {
      state.cards[event.cardId]!.rank = event.data.rank
    }

    if (event.data.unstarted) {
      state.cards[event.cardId]!.unstarted = event.data.unstarted
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
      if (event.data.before === 'investigation' && event.data.after === 'build') {
        if (card.workerLog?.status?.code === 'done') {
          delete card.workerLog.status
        }
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

  return false
}
