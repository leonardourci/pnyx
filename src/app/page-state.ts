import type { HydraEvent, HydraState } from './model.ts'
import { replayOwned } from './reducer.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentSession } from '#workers/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { liveTask } from '#tasks/select.ts'
import { ownerActor } from './actors.ts'

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
type ServerOnly = 'eventIds' | 'contextNotes' | 'questionReminders' | 'hydraMessages'
export type PageState = Omit<HydraState, ServerOnly>

function ownerMessage({ messages }: { messages: HydraState['hydraMessages'] }): HydraState['hydraOwnerMessage'] {
  const latest = messages?.findLast(message => ownerActor({ actor: message.actor }) && message.action === 'send')

  return latest && {
    id: latest.id,
    task: latest.task,
    text: latest.text,
  }
}

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
  const page: PageState & Partial<Pick<HydraState, ServerOnly>> = {
    ...state,
    hydraOwnerMessage: ownerMessage({ messages: state.hydraMessages }),
  }
  delete page.eventIds
  delete page.contextNotes
  delete page.questionReminders
  delete page.hydraMessages
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
    || event.type === 'task.reminder-due'
    || event.type === 'project.refreshed' || event.type === 'diagnostic.retry'
    || event.type === 'pnyx.upgrade'
    || (event.type === 'session.compaction' && event.cardId === HYDRA_CARD)
  const shown = card && pageShows({
    card,
    interest,
  })
  const hidden = !shown && !global
  const omitted = hidden || event.type.startsWith('task.steering.') || event.type.startsWith('task.source.')
    || event.type === 'task.wait-resumed'
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

  if (omitted) {
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

  if (event.type.startsWith('card.') || event.type.startsWith('task.moved-')
    || event.type === 'task.visibility' || sessionChange) {
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
  const latest = ownerMessage({ messages: state.hydraMessages })

  if (latest) {
    state.hydraOwnerMessage = latest
  }

  delete state.hydraMessages

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
