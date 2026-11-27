import type { Card, TaskStatus } from './model.ts'
import { ownerQuestions, type OwnerQuestion } from './questions.ts'
import type { AgentSession } from '#workers/model.ts'
import { agentActivity } from '#workers/activity.ts'
import { readyForReview } from '#tasks/delivery/model.ts'

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

export const hasCompletedOutcome = ({ card }: { card: Card }): boolean =>
  card.outcome?.closed === true || card.outcome?.state === 'done' || card.outcome?.state === 'cancelled'

export const hasBlockedWork = ({ card }: { card: Card }): boolean =>
  card.workerLog?.status?.code === 'blocked' || (card.outcome?.state === 'failed' && !card.outcome.closed)

export function hasMergedDelivery({ card }: { card: Card }): boolean {
  const requests = card.links.filter(link => link.kind === 'github_pr' && link.state !== 'closed')

  return requests.length > 0 && requests.every(link => link.state === 'merged')
}

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
  sessions,
  workingChildren,
  countDoneAt = true,
}: {
  card: Card
  cards?: Record<string, Card>
  sessions?: Record<string, AgentSession>
  workingChildren?: Set<string>
  // The done refresh records doneAt itself, so it counts a recorded one only while the worker reports done.
  countDoneAt?: boolean
}): CardStatus {
  const doneAt = countDoneAt ? card.doneAt : undefined
  const waiting = waitingQuestions({
    card,
    cards,
  })
  const worker = card.workerLog?.status
  const completedOutcome = hasCompletedOutcome({ card })
  const complete = worker?.code === 'done' || completedOutcome

  if (waiting.length || worker?.code === 'needs-you') {
    return {
      kind: 'asks',
      state: 'needs_you',
      text: 'needs you',
      count: waiting.length > 1 ? waiting.length : undefined,
      at: worker?.code === 'needs-you' ? worker.at : undefined,
    }
  }

  if (hasBlockedWork({ card })) {
    return {
      kind: 'blocked',
      state: 'blocked',
      text: 'blocked',
      at: worker?.code === 'blocked' ? worker.at : undefined,
    }
  }

  const activity = agentActivity({
    card,
    cards,
    sessions,
    workingChildren,
  })

  if (activity === 'working') {
    return {
      kind: 'working',
      state: 'working',
      text: 'running',
      at: card.workingSince,
    }
  }

  if (card.queue) {
    return {
      kind: 'queued',
      text: 'queued',
    }
  }

  if (card.hold) {
    return {
      kind: 'paused',
      state: 'paused',
      text: 'on hold',
      at: card.hold.at,
    }
  }

  if (card.wait) {
    const title = cards?.[card.wait.task]?.title ?? card.facts?.waitTitle ?? card.wait.task

    return {
      kind: 'waiting',
      state: 'paused',
      text: `waiting: ${title}`,
      at: card.wait.at,
    }
  }

  if (hasMergedDelivery({ card })) {
    return {
      kind: 'merged',
      text: 'PR merged',
    }
  }

  if (card.links.some(link => link.kind === 'github_pr' && link.state === 'open')) {
    return {
      kind: 'review',
      text: 'PR open',
    }
  }

  if (activity === 'finished' && !doneAt && !completedOutcome) {
    return {
      kind: 'finished',
      text: 'idle',
    }
  }

  if (complete || doneAt) {
    return {
      kind: 'done',
      state: 'done',
      text: 'done',
      at: worker?.code === 'done' ? worker.at : doneAt,
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
  source: 'note' | 'reminder' | 'review'
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

  const reviewUpdates = card.links.flatMap<CardUpdate>(link => {
    const at = link.checkedAt
    const openDecision = (card.asks ?? []).some(ask =>
      ask.kind === 'merge' && ask.url === link.url && !ask.closed && !ask.answered)

    if (!at || openDecision || !readyForReview({ link })) {
      return []
    }

    const title = (link.title ?? 'Pull request').replace(
      /[\\[\]]/g,
      '\\$&',
    )

    return [
      {
        text: `[${title}](${link.url}) is ready for review.`,
        at,
        source: 'review',
      },
    ]
  })
  const reminder = card.reminder

  if (reminder?.dueAt) {
    reviewUpdates.push({
      text: 'Reminder due',
      at: reminder.dueAt,
      source: 'reminder',
    })
  }

  return reviewUpdates.sort((
    a,
    b,
  ) => a.at.localeCompare(b.at)).at(-1)
}
