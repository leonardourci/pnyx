import type { EventType, HydraEvent, HydraState } from './model.ts'
import { replayOwned } from './reducer.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentSession } from '#workers/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { isManagedTask, knownCards, liveTask } from '#tasks/select.ts'

export interface PageInterest {
  cards: string[]
  hidden: boolean
}
export interface PageUpdate {
  seq: number
  event?: HydraEvent
  cards: Record<string, Card | null>
  references?: Record<string, Card>
  sessions?: Record<string, NonNullable<HydraState['sessions']>[string] | null>
  movedOut?: Record<string, NonNullable<HydraState['movedOut']>[string] | null>
  undone?: HydraState['undone']
  labelColors?: HydraState['labelColors']
}
export type PageState = Omit<HydraState, 'eventIds' | 'contextNotes' | 'questionReminders'>

// Which tabs replay an event: every tab, a tab that shows its card (and then also
// gets that card's sessions), or none, so a tab only gets the cards it changed.
// A column or Hydra change can show or hide any card, so every tab gets a snapshot instead.
type PageReach = 'every tab' | 'shown card' | 'shown card and sessions' | 'cards only' | 'snapshot'

const PAGE_REACH = {
  'task.wait-resumed': 'cards only',
  'hydra.context-delivered': 'every tab',
  'diagnostic.retry': 'every tab',
  'apply.recorded': 'shown card',
  'session.compaction': 'shown card',
  'pnyx.upgrade': 'every tab',
  'task.source.registered': 'cards only',
  'task.source.lavish.published': 'cards only',
  'task.source.started': 'cards only',
  'task.source.result': 'cards only',
  'task.source.alerted': 'cards only',
  'task.source.handled': 'cards only',
  'project.refreshed': 'every tab',
  'task.steering.queued': 'cards only',
  'task.steering.notified': 'cards only',
  'task.steering.handled': 'cards only',
  'task.steering.recovery': 'cards only',
  'card.pushed': 'shown card and sessions',
  'card.observed': 'shown card and sessions',
  'card.moved': 'shown card and sessions',
  'card.linked': 'shown card and sessions',
  'card.outcome': 'shown card and sessions',
  'card.replied': 'shown card and sessions',
  'card.noted': 'shown card and sessions',
  'board.view': 'every tab',
  'task.session': 'shown card and sessions',
  'board.configured': 'snapshot',
  'board.columns': 'snapshot',
  'board.agents': 'snapshot',
  'task.created': 'shown card',
  'task.brief': 'shown card',
  'task.owner-ask': 'shown card',
  'task.intent': 'shown card',
  'task.visibility': 'shown card and sessions',
  'task.retention': 'shown card',
  'hydra.memory': 'every tab',
  'task.declared': 'shown card',
  'task.asked': 'shown card',
  'task.ask.escalated': 'shown card',
  'task.ask.closed': 'shown card',
  'task.ask.deferred': 'shown card',
  'task.ask.reopened': 'shown card',
  'task.mirrored': 'shown card',
  'hydra.message': 'every tab',
  'hydra.status': 'every tab',
  'hydra.received': 'every tab',
  'hydra.operation': 'every tab',
  'hydra.agent-used': 'every tab',
  'hydra.agent-change': 'every tab',
  'hydra.review': 'every tab',
  'hydra.helper-started': 'every tab',
  'hydra.helper-finished': 'every tab',
  'hydra.helper-acknowledged': 'every tab',
  'hydra.dispatch-proposed': 'every tab',
  'hydra.dispatch-resolved': 'every tab',
  'hydra.dispatch-progress': 'every tab',
  'hydra.project': 'every tab',
  'chat.message': 'every tab',
  'task.launched': 'shown card',
  'task.permission': 'shown card',
  'task.project': 'shown card',
  'task.reminder': 'shown card',
  'task.reminder-due': 'every tab',
  'task.copy': 'shown card',
  'task.moved-out': 'shown card and sessions',
  'task.moved-in': 'shown card and sessions',
  'task.queue': 'shown card',
  'task.dependencies': 'shown card',
  'task.held': 'shown card',
  'task.released': 'shown card',
  'task.kind': 'shown card',
  'task.report': 'shown card',
  'task.report-reviewed': 'shown card',
  'task.landing': 'shown card',
} as const satisfies Record<EventType, PageReach>

export function pageCard({ card }: { card: Card }): Card {
  const visible = { ...card }
  delete visible.steering
  delete visible.externalSources

  return visible
}

// A hidden task keeps what chips, prerequisites, waits and answer heads read: no histories,
// texts or worker setup.
function pageReference({ card }: { card: Card }): Card {
  const reference = pageCard({ card })
  delete reference.statusLog
  delete reference.replies
  delete reference.brief
  delete reference.initialPrompt
  delete reference.intent
  delete reference.progress
  delete reference.projectRefresh
  delete reference.launch
  delete reference.settings
  delete reference.copy

  return reference
}

export const pageSnapshotEvent = ({ event }: { event: HydraEvent }) => PAGE_REACH[event.type] === 'snapshot'

export function pageShows({
  card,
  interest,
}: {
  card: Card
  interest: PageInterest
}): boolean {
  return card.id === HYDRA_CARD || interest.hidden || interest.cards.includes(card.id)
    || liveTask({ card })
}

function pageSession({
  session,
  state,
  interest,
}: {
  session: AgentSession
  state: HydraState
  interest: PageInterest
}): boolean {
  const card = session.taskId && state.cards[session.taskId]

  // Hydra's own session sits on a hidden hook card, and Hydra's card is projected from it.
  if (session.id === state.config?.hydra.session) {
    return true
  }

  return Boolean(card && pageShows({
    card,
    interest,
  }))
}

export function pageState({
  state,
  interest,
}: {
  state: HydraState
  interest: PageInterest
}): PageState {
  const page: PageState & Partial<Pick<HydraState, 'eventIds' | 'contextNotes' | 'questionReminders'>> = { ...state }
  delete page.eventIds
  delete page.contextNotes
  delete page.questionReminders
  const cards: Record<string, Card> = {}
  const references: Record<string, Card> = {}

  for (const card of Object.values(knownCards({ state }))) {
    if (pageShows({
      card,
      interest,
    })) {
      cards[card.id] = pageCard({ card })
    } else if (!isManagedTask({ card })) {
      references[card.id] = pageReference({ card })
    }
  }

  return {
    ...page,
    cards,
    references,
    sessions: Object.fromEntries(Object.entries(state.sessions ?? {}).filter(([
      , session,
    ]) => pageSession({
      session,
      state,
      interest,
    }))),
    keys: Object.fromEntries(Object.entries(state.keys).filter(([
      , id,
    ]) => Object.hasOwn(
      cards,
      id,
    ) || Object.hasOwn(
      references,
      id,
    ))),
  }
}

export function pageEvent({
  event,
  state,
  interest,
}: {
  event: HydraEvent
  state: HydraState
  interest: PageInterest
}): PageUpdate {
  const card = state.cards[event.cardId]
    ?? (event.type === 'task.moved-out' ? event.data.card : undefined)
  const reach: PageReach = PAGE_REACH[event.type]
  const shown = event.cardId === HYDRA_CARD || Boolean(card && pageShows({
    card,
    interest,
  }))
  const forwarded = reach === 'every tab' || reach === 'snapshot' || (reach !== 'cards only' && shown)
  const movedSessions = event.type === 'task.moved-in' || event.type === 'task.moved-out'
    ? event.data.sessions.filter(session => {
      const current = state.sessions?.[session.id]

      return current && pageSession({
        session: current,
        state,
        interest,
      })
    }) : []
  let projected: HydraEvent | undefined = event

  if (!forwarded) {
    projected = undefined
  } else if (event.type === 'task.moved-in') {
    projected = {
      ...event,
      data: {
        ...event.data,
        card: pageCard({ card: event.data.card }),
        sessions: movedSessions,
      },
    }
  } else if (event.type === 'task.moved-out') {
    projected = {
      ...event,
      data: {
        ...event.data,
        card: pageCard({ card: event.data.card }),
        sessions: movedSessions,
      },
    }
  }

  const ids = new Set([event.cardId])

  if (event.type === 'task.queue') {
    for (const id of event.data.order ?? []) {
      ids.add(id)
    }
  }

  const sessions: NonNullable<PageUpdate['sessions']> = {}
  const sessionChange = event.type === 'task.session' ? event.data : undefined

  if (sessionChange?.before) {
    ids.add(sessionChange.before)
  }

  if (sessionChange?.after) {
    ids.add(sessionChange.after)
  }

  if (reach === 'shown card and sessions') {
    for (const session of Object.values(state.sessions ?? {})) {
      if (session.originCardId === event.cardId || session.taskId === event.cardId
        || session.id === sessionChange?.session
        || card?.sessionIds?.includes(session.id)) {
        sessions[session.id] = pageSession({
          session,
          state,
          interest,
        }) ? session : null

        if (session.taskId) {
          ids.add(session.taskId)
        }

        if (session.id === state.config?.hydra.session) {
          ids.add(HYDRA_CARD)
        }
      }
    }
  }

  if (event.type === 'task.moved-out' || event.type === 'task.moved-in') {
    for (const session of event.data.sessions) {
      const current = state.sessions?.[session.id]
      sessions[session.id] = current && pageSession({
        session: current,
        state,
        interest,
      }) ? current : null
    }
  }

  const cards: PageUpdate['cards'] = {}
  const references: NonNullable<PageUpdate['references']> = {}

  for (const id of ids) {
    const current = state.cards[id]
    const visible = current && pageShows({
      card: current,
      interest,
    })
    cards[id] = visible ? pageCard({ card: current }) : null

    if (current && !visible && !isManagedTask({ card: current })) {
      references[id] = pageReference({ card: current })
    }
  }

  const update: PageUpdate = {
    seq: event.seq,
    event: projected,
    cards,
  }

  if (Object.keys(sessions).length) {
    update.sessions = sessions
  }

  if (Object.keys(references).length) {
    update.references = references
  }

  const moved = state.movedOut?.[event.cardId]

  if (event.type === 'task.moved-out' && moved) {
    update.movedOut = { [event.cardId]: moved }
  }

  if (event.type === 'task.moved-in') {
    update.movedOut = { [event.cardId]: null }
  }

  if (event.undoes) {
    update.undone = { [event.undoes]: event.id }
  }

  if (event.labelColors) {
    update.labelColors = state.labelColors
  }

  return update
}

export function applyPageUpdate({
  state,
  update,
}: {
  state: HydraState
  update: PageUpdate
}): void {
  if (update.seq <= state.seq) {
    return
  }

  if (update.event) {
    replayOwned({
      state,
      events: [update.event],
    })
  } else {
    state.seq = update.seq
  }

  // The server owns deduplication; page events already arrive in sequence.
  state.eventIds = {}
  delete state.contextNotes
  delete state.questionReminders

  for (const [
    cardId,
    card,
  ] of Object.entries(update.cards)) {
    delete state.references?.[cardId]

    if (card === null) {
      delete state.cards[cardId]

      for (const [
        key,
        id,
      ] of Object.entries(state.keys)) {
        if (id === cardId) {
          delete state.keys[key]
        }
      }
    } else {
      state.cards[cardId] = card
      state.keys[card.key] = cardId
    }
  }

  if (update.references) {
    state.references = {
      ...state.references,
      ...update.references,
    }

    for (const reference of Object.values(update.references)) {
      state.keys[reference.key] = reference.id
    }
  }

  if (update.sessions) {
    const sessions = state.sessions ?? {}

    for (const [
      id,
      session,
    ] of Object.entries(update.sessions)) {
      if (session) {
        sessions[id] = session
      } else {
        delete sessions[id]
      }
    }

    state.sessions = sessions
  }

  if (update.undone) {
    state.undone = {
      ...state.undone,
      ...update.undone,
    }
  }

  if (update.labelColors) {
    state.labelColors = update.labelColors
  }

  if (update.movedOut) {
    const movedOut = { ...state.movedOut }

    for (const [
      id,
      moved,
    ] of Object.entries(update.movedOut)) {
      if (moved) {
        movedOut[id] = moved
      } else {
        delete movedOut[id]
      }
    }

    state.movedOut = movedOut
  }
}
