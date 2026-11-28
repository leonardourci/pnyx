import type { Card, TaskStatus } from './model.ts'
import { ownerQuestions, type OwnerQuestion } from './questions.ts'
import type { AgentSession } from '#workers/model.ts'
import { agentActivity } from '#workers/activity.ts'
import { completedOutcome } from '#tasks/delivery/model.ts'

export interface CardStatus {
  state?: TaskStatus
  kind: string
  text: string
  at?: string
  // Questions still waiting on the owner, when there are several.
  count?: number
}

// An answer on its way leaves its question with the worker; a failed one comes back to the owner.
const inFlight = ({ question }: { question: OwnerQuestion }) =>
  question.delivery?.state === 'queued' || question.delivery?.state === 'delivery_unknown'

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

export function cardStatus({
  card,
  cards,
  sessions,
  sessionsWithWorkingChild,
}: {
  card: Card
  cards?: Record<string, Card>
  sessions?: Record<string, AgentSession>
  sessionsWithWorkingChild?: ReadonlySet<string>
}): CardStatus {
  const waiting = waitingQuestions({
    card,
    cards,
  })

  if (waiting.length) {
    return {
      kind: 'asks',
      state: 'needs_you',
      text: 'needs you',
      count: waiting.length > 1 ? waiting.length : undefined,
    }
  }

  const activity = agentActivity({
    card,
    cards,
    sessions,
    sessionsWithWorkingChild,
  })

  if (activity === 'working') {
    return {
      kind: 'working',
      state: 'working',
      text: 'running',
      at: card.workingSince,
    }
  }

  const outcome = card.outcome

  if (outcome && completedOutcome({ outcome })) {
    return {
      kind: 'done',
      state: 'done',
      text: outcome.state,
      at: card.doneAt,
    }
  }

  const parked = Boolean(card.queue || card.hold || card.wait)

  if (activity === 'finished' || parked) {
    return {
      kind: 'finished',
      text: 'idle',
    }
  }

  if (activity === 'stopped') {
    return {
      kind: 'stopped',
      text: 'ended',
      at: card.stoppedAt,
    }
  }

  return {
    kind: card.agent ? 'unknown' : 'not-started',
    text: card.agent ? 'activity unknown' : noWorkerText({ card }),
  }
}

const neverStarted = ({ card }: { card: Card }) => !card.agent && !card.launch

function noWorkerText({ card }: { card: Card }): string {
  if (!neverStarted({ card })) {
    return 'no worker assigned'
  }

  return card.unstarted ? `not started: ${card.unstarted}` : 'not started, no reason given'
}

export function workerGap({ card }: { card: Card }): string {
  const waitShown = Boolean(card.hold || card.wait || card.queue || card.prerequisites?.length)

  return neverStarted({ card }) && !waitShown ? `none: ${noWorkerText({ card })}` : 'none'
}

export const statusLabel = ({ status }: { status: CardStatus }) => {
  const text = status.text.replace(
    /^./,
    c => c.toUpperCase(),
  )

  return status.count ? `${text} · ${status.count}` : text
}

interface CardUpdate {
  text: string
  at: string
  source: 'note' | 'reminder'
}

export function currentState({
  card,
  workerOnly = false,
}: {
  card: Card
  workerOnly?: boolean
}): CardUpdate | undefined {
  const line = card.workerLog?.latest
  const workerUpdate = line ? {
    text: line.code === 'invalid' ? `Invalid worker.log line: ${line.text}` : line.text,
    at: line.at,
    source: 'note' as const,
  } : undefined

  if (workerUpdate || workerOnly) {
    return workerUpdate
  }

  const reminder = card.reminder

  return reminder?.dueAt ? {
    text: 'Reminder due',
    at: reminder.dueAt,
    source: 'reminder',
  } : undefined
}
