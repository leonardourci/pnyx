import { applyHistory } from '#hydra/history.ts'
import type { HydraState, HydraEvent } from './model.ts'
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
import { applyHydra } from '#hydra/reduce.ts'
import { applyMemory } from '#memory/reduce.ts'
import { applyProject } from '#projects/reduce.ts'
import { applyView } from '#preferences/reduce.ts'
import { applyTask } from '#tasks/reduce.ts'
import { applyDispatchProposal, applyLaunch, applySessionMove } from '#workers/reduce.ts'
import { applyCardEvent } from '#tasks/card-events.ts'
import { applyRecovery } from '#diagnostics/recovery-state.ts'

export function emptyHydra(): HydraState {
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
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.seq <= state.seq || event.id in state.eventIds) {
    return false
  }

  state.seq = event.seq
  state.eventIds[event.id] = event.seq

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

  if (applyRecovery({
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
    || applyHydra({
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
  state: HydraState
  events: Iterable<HydraEvent>
}): HydraState {
  for (const event of events) {
    if (apply({
      state,
      event,
    })) {
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
  state: HydraState
  events: Iterable<HydraEvent>
}): HydraState {
  return replayOwned({
    state: structuredClone(state),
    events,
  })
}

export function reduce({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): HydraState {
  return replay({
    state,
    events: [event],
  })
}
