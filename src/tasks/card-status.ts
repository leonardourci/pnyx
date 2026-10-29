import type { Card } from './model.ts'
import { askWording, openAsks } from './questions.ts'
import { agentActor, reportActor } from '#hydra/hydra.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import { agentActivity } from '#workers/activity.ts'

const ANSWER_STATES = {
  queued: 'answer sending',
  delivery_unknown: 'answer delivery uncertain',
  failed: 'answer not sent',
} as const

type AnswerState = keyof typeof ANSWER_STATES

export interface OwnerDecision {
  id: string
  text: string
  // The receipt of an answer already sent but not yet confirmed.
  answer?: AnswerState
}

// Everything waiting on the owner: the status word counts it and the closed card shows its first item.
export function ownerDecisions({ card }: { card: Card }): OwnerDecision[] {
  const sent = ({ id }: { id: string }) => {
    const state = card.replies?.filter(reply => reply.answers === id).at(-1)?.state

    return state && state in ANSWER_STATES ? state as AnswerState : undefined
  }

  return [
    ...(card.permissions ?? []).filter(request => request.status === 'pending').map(request => ({
      id: `permission:${request.id}`,
      text: request.questions?.map(question => question.question).join(' ') || `Allow ${request.tool}?`,
    })),
    ...card.attention
      .filter(request => request.key !== INTERRUPTED && request.blocking && !request.answered)
      .map(request => ({
        id: `attention:${request.key}`,
        text: request.text ?? request.questions?.map(question => question.question).join(' ') ?? 'The agent is waiting for you',
      })),
    ...openAsks({
      card,
      audience: 'owner',
    }).map(ask => ({
      id: ask.id,
      text: askWording({ ask }).question,
      answer: sent({ id: ask.id }),
    })),
  ]
}

export interface CardStatus {
  kind: string
  text: string
  at?: string
  // Decisions still waiting on the owner, when there are several.
  count?: number
}

// The status word's rule, newest information first; the page adds elapsed times to done and stopped.
export function cardStatus({ card }: { card: Card }): CardStatus {
  if (card.doneAt) {
    return {
      kind: 'done',
      text: 'done',
      at: card.doneAt,
    }
  }

  const decisions = ownerDecisions({ card })
  const waiting = decisions.filter(decision => !decision.answer)

  if (waiting.length || card.reminder?.dueAt) {
    return {
      kind: 'asks',
      text: 'asks',
      count: waiting.length > 1 ? waiting.length : undefined,
    }
  }

  const answer = ([
    'failed',
    'delivery_unknown',
    'queued',
  ] as const).find(state => decisions.some(decision => decision.answer === state))

  if (answer) {
    return {
      kind: 'answering',
      text: ANSWER_STATES[answer],
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

  const declared = waitingDeclaration({
    card,
    activity,
  })

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
    text: activity === 'working' ? 'working' : activity === 'finished' ? 'finished its turn' : card.agent ? 'activity unknown' : 'no worker assigned',
  }
}

const WAITS = {
  needs_you: {
    kind: 'asks',
    text: 'asks',
  },
  blocked: {
    kind: 'blocked',
    text: 'blocked',
  },
  paused: {
    kind: 'waiting',
    text: 'paused',
  },
} as const

// A needs-you, blocked or paused declaration says more than "finished its turn", unless the
// worker has since started working again or asked Hydra something newer.
function waitingDeclaration({
  card,
  activity,
}: {
  card: Card
  activity: ReturnType<typeof agentActivity>
}) {
  const declared = card.status
  const wait = declared && WAITS[declared.state as keyof typeof WAITS]
  // A column's default declaration at creation has no note and says nothing about the work.
  const said = !!declared?.note.trim() && agentActor({ actor: declared.actor })

  if (!declared || !wait || !said) {
    return undefined
  }

  const resumed = activity === 'working' && !!card.workingSince && card.workingSince > declared.at
  const askedLater = openAsks({
    card,
    audience: 'hydra',
  }).some(ask => (ask.escalated?.at ?? ask.at) > declared.at)

  return resumed || askedLater ? undefined : {
    ...wait,
    at: declared.at,
  }
}

export const statusLabel = ({ status }: {
  status: {
    kind: string
    text: string
    count?: number
  }
}) => {
  if (status.kind === 'asks') {
    return status.count ? `Needs you · ${status.count}` : 'Needs you'
  }

  return status.text.replace(
    /^./,
    c => c.toUpperCase(),
  )
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
