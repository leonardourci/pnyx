import type { TitanState } from './model.ts'
import type { TitanMessage } from '#titan/model.ts'
import { ownerActor } from './actors.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentSession } from '#workers/model.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { cardReference } from './card-reference.ts'
import { isManagedTask, knownCards, liveTask } from '#tasks/select.ts'

export interface PageInterest {
  cards: string[]
  hidden: boolean
}
type ServerOnly = 'eventIds' | 'contextNotes' | 'questionReminders' | 'hydraMessages'
export type PageState = Omit<TitanState, ServerOnly>

function ownerMessage({ messages }: {
  messages: TitanState['hydraMessages']
}): TitanState['hydraOwnerMessage'] {
  const ownerSend = ({ message }: { message: TitanMessage }) =>
    ownerActor({ actor: message.actor }) && message.action === 'send'
  const latest = messages?.findLast(message => ownerSend({ message }))

  return latest && {
    id: latest.id,
    task: latest.task,
    text: latest.text,
  }
}

function pageCard({ card }: { card: Card }): Card {
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
  return card.id === TITAN_CARD || interest.hidden || interest.cards.includes(card.id)
    || liveTask({ card })
}

function pageSession({
  session,
  state,
  interest,
}: {
  session: AgentSession
  state: TitanState
  interest: PageInterest
}): boolean {
  const card = session.taskId && state.cards[session.taskId]

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
  state: TitanState
  interest: PageInterest
}): PageState {
  const page: PageState & Partial<Pick<TitanState, ServerOnly>> = {
    ...state,
    hydraOwnerMessage: ownerMessage({ messages: state.hydraMessages }),
  }
  delete page.hydraMessages
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
      references[card.id] = cardReference({ card })
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
