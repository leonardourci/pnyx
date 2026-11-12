import type { HydraEvent, HydraState } from './model.ts'
import { replayOwned } from './reducer.ts'
import type { Card } from '#tasks/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { liveTask } from '#tasks/select.ts'

export interface PageInterest {
  cards: string[]
  hidden: boolean
  unavailable?: string[]
}
export interface PageUpdate {
  seq: number
  event?: HydraEvent
  cards: Record<string, Card | null>
  sessions?: Record<string, NonNullable<HydraState['sessions']>[string] | null>
  movedOut?: HydraState['movedOut']
  undone?: HydraState['undone']
  labelColors?: HydraState['labelColors']
}
export type PageState = Omit<HydraState, 'eventIds' | 'contextNotes' | 'questionReminders'>

export function pageCard({ card }: { card: Card }): Card {
  const visible = { ...card }
  delete visible.steering
  delete visible.externalSources

  return visible
}

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
  const cards = Object.fromEntries(Object.values(state.cards)
    .filter(card => pageShows({
      card,
      interest,
    }))
    .map(card => [
      card.id,
      pageCard({ card }),
    ]))

  return {
    ...page,
    cards,
    keys: Object.fromEntries(Object.entries(state.keys).filter(([
      , id,
    ]) => Object.hasOwn(
      cards,
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
  const global = event.type.startsWith('hydra.') || event.type.startsWith('board.')
    || event.type === 'chat.message' || event.type === 'task.reminder-due'
    || event.type === 'project.refreshed' || event.type === 'diagnostic.retry'
    || event.type === 'pnyx.upgrade' || event.type === 'session.compaction'
  const shown = card && pageShows({
    card,
    interest,
  })
  const hidden = !shown && !global
  const omitted = hidden || event.type.startsWith('task.steering.') || event.type.startsWith('task.source.')
    || event.type === 'task.wait-resumed'
  let projected: HydraEvent | undefined = event

  if (omitted) {
    projected = undefined
  } else if (event.type === 'task.moved-in') {
    projected = {
      ...event,
      data: {
        ...event.data,
        card: pageCard({ card: event.data.card }),
      },
    }
  } else if (event.type === 'task.moved-out') {
    projected = {
      ...event,
      data: {
        ...event.data,
        card: pageCard({ card: event.data.card }),
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

  if (event.type.startsWith('card.') || event.type.startsWith('task.moved-') || sessionChange) {
    for (const session of Object.values(state.sessions ?? {})) {
      if (session.originCardId === event.cardId || session.id === sessionChange?.session
        || card?.sessionIds?.includes(session.id)) {
        sessions[session.id] = session

        if (session.taskId) {
          ids.add(session.taskId)
        }
      }
    }
  }

  if (event.type === 'task.moved-out' || event.type === 'task.moved-in') {
    for (const session of event.data.sessions) {
      sessions[session.id] = state.sessions?.[session.id] ?? null
    }
  }

  const cards = Object.fromEntries([...ids].flatMap(id => {
    const current = state.cards[id]

    if (!current) {
      return [
        [
          id,
          null,
        ],
      ]
    }

    return [
      [
        id,
        pageShows({
          card: current,
          interest,
        }) ? pageCard({ card: current }) : null,
      ],
    ]
  }))
  const update: PageUpdate = {
    seq: event.seq,
    event: projected,
    cards,
  }

  if (Object.keys(sessions).length) {
    update.sessions = sessions
  }

  const moved = state.movedOut?.[event.cardId]

  if (event.type === 'task.moved-out' && moved) {
    update.movedOut = { [event.cardId]: moved }
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
    state.movedOut = {
      ...state.movedOut,
      ...update.movedOut,
    }
  }
}
