import type { Card, TaskStatus } from './model.ts'
import { ownerQuestions, type OwnerQuestion } from './questions.ts'
import { openAsks } from './ask-state.ts'
import { reportActor } from '#hydra/hydra.ts'
import type { ReplyState } from '#workers/model.ts'
import { agentActivity } from '#workers/activity.ts'
import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import { readyForReview } from '#tasks/delivery/model.ts'

const ACTIVITY_TEXT: Record<string, string> = {
  working: 'working',
  finished: 'finished its turn',
}

const ANSWER_STATES: Partial<Record<ReplyState, string>> = {
  queued: 'answer sending',
  delivery_unknown: 'answer delivery uncertain',
}

const WAITS: Partial<Record<TaskStatus, Omit<CardStatus, 'at'>>> = {
  needs_you: {
    kind: 'waiting',
    text: 'waiting on a decision',
  },
  blocked: {
    kind: 'blocked',
    text: 'blocked',
  },
  paused: {
    kind: 'waiting',
    text: 'paused',
  },
}

export interface CardStatus {
  kind: string
  text: string
  at?: string
  // Questions still waiting on the owner, when there are several.
  count?: number
}

// An answer on its way leaves its question with the worker; a failed one comes back to the owner.
const inFlight = ({ question }: { question: OwnerQuestion }) =>
  !!question.delivery && question.delivery.state in ANSWER_STATES

// What the owner still has to answer, failed sends included; the status word and closed card share it.
export const waitingQuestions = ({
  card,
  cards,
}: {
  card: Card
  cards?: Record<string, Card>
}) =>
  ownerQuestions({
    card,
    cards,
  }).filter(question =>
    !question.ask?.deferredUntil && !inFlight({ question }))

// The status word's rule, newest information first; the page adds elapsed times to done and stopped.
export function cardStatus({
  card,
  cards,
}: {
  card: Card
  cards?: Record<string, Card>
}): CardStatus {
  if (card.doneAt) {
    return {
      kind: 'done',
      text: 'done',
      at: card.doneAt,
    }
  }

  const waiting = waitingQuestions({
    card,
    cards,
  })
  const unsent = waiting.filter(question => question.delivery?.state === 'failed')
  const reviewOnly = waiting.length > 0 && waiting.every(question => question.ask?.kind === 'merge')
  const readyReviews = reviewOnly && waiting.every(question => card.links.some(link =>
    link.url === question.ask?.url && readyForReview({ link })))

  if (readyReviews && !card.reminder?.dueAt && !unsent.length) {
    return {
      kind: 'asks',
      text: 'ready for review',
      count: waiting.length > 1 ? waiting.length : undefined,
    }
  }

  if (waiting.length || card.reminder?.dueAt) {
    return {
      kind: 'asks',
      text: unsent.length && unsent.length === waiting.length ? 'answer not sent' : 'needs you',
      count: waiting.length > 1 ? waiting.length : undefined,
    }
  }

  const states = ownerQuestions({
    card,
    cards,
  }).map(question => question.delivery?.state)
  // Delivery that may have failed says more than delivery still on its way.
  const sending = ([
    'delivery_unknown',
    'queued',
  ] as const).find(state => states.includes(state))

  if (sending) {
    return {
      kind: 'answering',
      text: ANSWER_STATES[sending]!,
    }
  }

  if (card.hold) {
    return {
      kind: 'paused',
      text: 'talking',
      at: card.hold.at,
    }
  }

  const explicitWait = card.wait && waitStatus({
    card,
    cards,
  })

  if (explicitWait) {
    return explicitWait
  }

  const activity = agentActivity({
    card,
    cards,
  })

  if (activity === 'stopped') {
    return {
      kind: 'stopped',
      text: 'stopped',
      at: card.stoppedAt ?? card.updatedAt,
    }
  }

  const declared = waitingDeclaration({ card })

  if (declared) {
    return waitStatus({
      card,
      cards,
    }) ?? declared
  }

  if (activity !== 'working' && openAsks({
    card,
    audience: 'hydra',
  }).length) {
    return {
      kind: 'asks-hydra',
      text: 'asks Hydra',
    }
  }

  if (!card.agent && card.queue) {
    return {
      kind: 'queued',
      text: 'queued',
    }
  }

  return {
    kind: activity ?? 'not-started',
    text: ACTIVITY_TEXT[activity ?? ''] ?? (card.agent ? 'activity unknown' : card.mirror ? 'not started' : 'no worker assigned'),
  }
}

// A later worker turn, a new question for Hydra or an owner answer makes an earlier wait note stale.
function waitingDeclaration({ card }: { card: Card }) {
  const declared = card.status
  const wait = declared && WAITS[declared.state]
  const requestedPause = declared?.state === 'paused'
    && (declared.actor === HYDRA_ACTOR || ownerActor({ actor: declared.actor }))

  // Pnyx's own declarations (a column's default, a fired reminder, a detached worker) say nothing about the work.
  if (!declared || !wait || !declared.note.trim()
    || (!reportActor({ actor: declared.actor }) && !requestedPause)) {
    return undefined
  }

  const resumed = (card.turnStartedAt ?? '') > declared.at
  const askedLater = (card.asks ?? []).some(ask => ask.audience === 'hydra' && (ask.escalated?.at ?? ask.at) > declared.at)
  const answered = (card.asks ?? []).some(ask => ask.audience === 'owner' && (ask.answeredAt ?? '') > declared.at)

  return resumed || askedLater || answered ? undefined : {
    ...wait,
    at: declared.at,
  }
}

export function waitStatus({
  card,
  cards,
}: {
  card: Card
  cards?: Record<string, Card>
}): CardStatus | undefined {
  if (card.wait) {
    const dependency = cards?.[card.wait.task]

    return {
      kind: 'waiting',
      text: `waiting: ${dependency?.title ?? card.wait.task}`,
      at: card.wait.at,
    }
  }

  const declaration = waitingDeclaration({ card })

  if (card.status?.state === 'paused' && declaration) {
    return {
      ...declaration,
      text: `waiting: ${card.status.note}`,
    }
  }
}

export const statusLabel = ({ status }: { status: CardStatus }) => {
  const text = status.text.replace(
    /^./,
    c => c.toUpperCase(),
  )

  return status.count ? `${text} · ${status.count}` : text
}

// Where the task stands, in the worker's own newest words: its latest status note or progress report.
export function currentState({ card }: { card: Card }): {
  text: string
  at: string
  source: 'note' | 'progress'
} | undefined {
  const note = (card.statusLog ?? [])
    .filter(entry => entry.note.trim() && reportActor({ actor: entry.actor }))
    .at(-1)
  const said = [
    note ? {
      text: note.note,
      at: note.at,
      source: 'note' as const,
    } : undefined,
    card.progress ? {
      text: card.progress.text,
      at: card.progress.at,
      source: 'progress' as const,
    } : undefined,
  ].filter(entry => entry !== undefined)

  return said.sort((
    a,
    b,
  ) => a.at.localeCompare(b.at)).at(-1)
}
