import type { HydraState } from './model.ts'
import type { HydraMessage } from '#hydra/model.ts'
import { ownerActor } from './actors.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentSession } from '#workers/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { isManagedTask, knownCards, liveTask } from '#tasks/select.ts'

export interface PageInterest {
  cards: string[]
  hidden: boolean
}
type ServerOnly = 'eventIds' | 'contextNotes' | 'questionReminders' | 'hydraMessages'
export type PageState = Omit<HydraState, ServerOnly>

export function ownerMessage({ messages }: {
  messages: HydraState['hydraMessages']
}): HydraState['hydraOwnerMessage'] {
  const ownerSend = ({ message }: { message: HydraMessage }) =>
    ownerActor({ actor: message.actor }) && message.action === 'send'
  const latest = messages?.findLast(message => ownerSend({ message }))

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

// A hidden task keeps what chips, prerequisites, waits and answer leads read: no histories,
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
  const page: PageState & Partial<Pick<HydraState, ServerOnly>> = {
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
