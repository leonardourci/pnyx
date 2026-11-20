import type { Card, TaskStatus } from './model.ts'
import { ownerQuestions, type OwnerQuestion } from './questions.ts'
import { reportActor } from '#hydra/hydra.ts'
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
  sessions,
}: {
  card: Card
  cards?: Record<string, Card>
  sessions?: Record<string, AgentSession>
}): CardStatus {
  const waiting = waitingQuestions({
    card,
    cards,
  })
  const worker = card.workerLog?.status

  if (waiting.length || worker?.code === 'needs-you') {
    return {
      kind: 'asks',
      state: 'needs_you',
      text: 'needs you',
      count: waiting.length > 1 ? waiting.length : undefined,
      at: worker?.at,
    }
  }

  if (worker?.code === 'blocked') {
    return {
      kind: 'blocked',
      state: 'blocked',
      text: 'blocked',
      at: worker.at,
    }
  }

  const activity = agentActivity({
    card,
    cards,
    sessions,
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

  const requests = card.links.filter(link => link.kind === 'github_pr' && link.state !== 'closed')

  if (requests.length && requests.every(link => link.state === 'merged')) {
    return {
      kind: 'merged',
      text: 'PR merged',
    }
  }

  if (requests.some(link => link.state === 'open')) {
    return {
      kind: 'review',
      text: 'PR open',
    }
  }

  if (activity === 'finished' && !card.doneAt && !card.outcome?.closed) {
    return {
      kind: 'finished',
      text: 'idle',
    }
  }

  if (worker?.code === 'done' || card.doneAt || card.outcome?.closed) {
    return {
      kind: 'done',
      state: 'done',
      text: 'done',
      at: worker?.at ?? card.doneAt,
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
    text: card.agent ? 'activity unknown' : card.mirror ? 'not started' : noWorkerText({ card }),
  }
}

const neverStarted = ({ card }: { card: Card }) => !card.agent && !card.mirror && !card.launch

export function noWorkerText({ card }: { card: Card }): string {
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
  const label = status.kind === 'working' ? 'running' : status.text
  const text = label.replace(
    /^./,
    c => c.toUpperCase(),
  )

  return status.count ? `${text} · ${status.count}` : text
}

export function currentState({ card }: { card: Card }): {
  text: string
  at: string
  source: 'note' | 'progress' | 'reminder' | 'review'
} | undefined {
  if (card.workerLog) {
    const line = card.workerLog.latest

    return {
      text: line.code === 'invalid' ? `Invalid worker.log line: ${line.text}` : line.text,
      at: line.at,
      source: 'note',
    }
  }

  const note = (card.statusLog ?? [])
    .filter(entry => entry.note.trim() && reportActor({ actor: entry.actor }))
    .at(-1)
  const reviewUpdates = card.links.flatMap(link => {
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
        source: 'review' as const,
      },
    ]
  })
  const said = [
    ...reviewUpdates,
    card.reminder?.dueAt ? {
      text: 'Reminder due',
      at: card.reminder.dueAt,
      source: 'reminder' as const,
    } : undefined,
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
