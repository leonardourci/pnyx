import { applySessionFacts } from '#workers/session-facts.ts'
import { recordEventId } from './command-meta.ts'
import { draft } from './draft.ts'
import { applyHistory } from '#titan/history.ts'
import type { TitanState, TitanEvent } from './model.ts'
import { EVENT_VERSION } from '#store/events.ts'
import { applyLabelColors } from '#tasks/labels.ts'
import { applyCompaction } from '#workers/compaction/state.ts'
import { applyUpgrade } from '#upgrade/state.ts'
import { applyExternalSource } from '#task-sources/state.ts'
import { applySteering } from '#workers/steering.ts'
import { applyDependencies } from '#tasks/dependencies.ts'
import { applyQueue } from '#workers/queue.ts'
import { applyReminder, stopReminders } from '#tasks/reminders.ts'
import { applyPermission } from '#workers/permission-rules.ts'
import { applyAsk } from '#tasks/ask-reducer.ts'
import { applyHelper } from '#routine-helper/state.ts'
import { refreshDone } from '#tasks/retention-rules.ts'
import { applyTitan } from '#titan/reduce.ts'
import { applyMemory } from '#memory/reduce.ts'
import { applyProject } from '#projects/reduce.ts'
import { applyView } from '#preferences/reduce.ts'
import { applyTask } from '#tasks/reduce.ts'
import { applyDispatchProposal, applyLaunch, applySessionMove } from '#workers/reduce.ts'
import { applyCardEvent } from '#tasks/card-events.ts'
import { applyRecovery } from '#diagnostics/recovery-state.ts'
import { applyContextNotes } from '#titan/context-notes.ts'
import { applyTitanMove } from '#tasks/move-state.ts'

export function emptyTitan(): TitanState {
  return {
    v: EVENT_VERSION,
    seq: 0,
    cards: {},
    keys: {},
    eventIds: {},
    undone: {},
  }
}

function apply({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): boolean {
  if (event.seq <= state.seq || Object.hasOwn(
    state.eventIds,
    event.id,
  )) {
    return false
  }

  state.seq = event.seq
  state.changedAt = event.at
  recordEventId({
    state,
    id: event.id,
    seq: event.seq,
  })

  if (event.type === 'apply.recorded') {
    return true
  }

  applyLabelColors({
    state,
    colors: event.labelColors,
  })

  applyHistory({
    state,
    event,
  })

  applyContextNotes({
    state,
    event,
  })

  if (event.type === 'titan.context-delivered' || applyRecovery({
    state,
    event,
  }) || applyCompaction({
    state,
    event,
  }) || applyUpgrade({
    state,
    event,
  }) || applyExternalSource({
    state,
    event,
  }) || applySteering({
    state,
    event,
  }) || applyTitanMove({
    state,
    event,
  }) || applyDependencies({
    state,
    event,
  }) || applyQueue({
    state,
    event,
  }) || applyReminder({
    state,
    event,
  })
    || applyPermission({
      state,
      event,
    })
    || applyAsk({
      state,
      event,
    })
    || applyHelper({
      state,
      event,
    })
    || applyTitan({
      state,
      event,
    })
    || applyMemory({
      state,
      event,
    })
    || applyProject({
      state,
      event,
    })
    || applyDispatchProposal({
      state,
      event,
    })
    || applyLaunch({
      state,
      event,
    })
    || applyTask({
      state,
      event,
    })) {
    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    return true
  }

  if (event.type === 'session.observed') {
    applySessionFacts({
      state,
      event,
    })

    return true
  }

  if (event.type === 'chat.message') {
    return true
  }

  if (applyView({
    state,
    event,
  })) {
    return true
  }

  if (applySessionMove({
    state,
    event,
  })) {
    return true
  }

  return applyCardEvent({
    state,
    event,
  })
}

export function replayOwned({
  state,
  events,
}: {
  state: TitanState
  events: Iterable<TitanEvent>
}): TitanState {
  for (const event of events) {
    if (apply({
      state,
      event,
    })) {
      const card = state.cards[event.cardId]

      if (card && event.notices) {
        card.notices = event.notices
      }

      stopReminders({
        state,
        event,
      })
      refreshDone({
        state,
        at: event.at,
      })
    }
  }

  return state
}

export function replay({
  state,
  events,
}: {
  state: TitanState
  events: Iterable<TitanEvent>
}): TitanState {
  return draft({
    state,
    change: ({ state }) => {
      replayOwned({
        state,
        events,
      })
    },
  })
}

export function reduce({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): TitanState {
  return replay({
    state,
    events: [event],
  })
}
