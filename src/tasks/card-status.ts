import type { Card, TaskStatus } from './model.ts'
import { openAsks, ownerQuestions, type OwnerQuestion } from './questions.ts'
import { reportActor } from '#hydra/hydra.ts'
import type { ReplyState } from '#workers/model.ts'
import { agentActivity } from '#workers/activity.ts'

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
export const waitingQuestions = ({ card }: { card: Card }) =>
  ownerQuestions({ card }).filter(question => !inFlight({ question }))

// The status word's rule, newest information first; the page adds elapsed times to done and stopped.
export function cardStatus({ card }: { card: Card }): CardStatus {
  if (card.doneAt) {
    return {
      kind: 'done',
      text: 'done',
      at: card.doneAt,
    }
  }

  const waiting = waitingQuestions({ card })
  const unsent = waiting.filter(question => question.delivery?.state === 'failed')

  if (waiting.length || card.reminder?.dueAt) {
    return {
      kind: 'asks',
      text: unsent.length && unsent.length === waiting.length ? 'answer not sent' : 'needs you',
      count: waiting.length > 1 ? waiting.length : undefined,
    }
  }

  const states = ownerQuestions({ card }).map(question => question.delivery?.state)
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

  const activity = agentActivity({ card })

  if (activity === 'stopped') {
    return {
      kind: 'stopped',
      text: 'stopped',
      at: card.stoppedAt ?? card.updatedAt,
    }
  }

  const declared = waitingDeclaration({ card })

  if (declared) {
    return declared
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

// A worker's needs-you, blocked or paused note shows until a later turn starts, it asks Hydra again or the owner answers.
function waitingDeclaration({ card }: { card: Card }) {
  const declared = card.status
  const wait = declared && WAITS[declared.state]

  // Pnyx's own declarations (a column's default, a fired reminder, a detached worker) say nothing about the work.
  if (!declared || !wait || !declared.note.trim() || !reportActor({ actor: declared.actor })) {
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
