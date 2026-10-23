import { ownerGates } from './gates.ts'
import type { Card, Column, HydraEvent, HydraState, TaskStatus } from './model.ts'
import { HYDRA_CARD, hydraConfig, roleColumn } from './hydra.ts'
import { INTERRUPTED } from './tasks.ts'

type Stage = 'in_progress' | 'needs_you' | 'parked' | 'done'

const MOVE = ':lifecycle'

// hydra check skips these moves by id; it already lists their cause.
export const lifecycleMoveId = ({
  event,
  cardId,
}: {
  event: string
  cardId: string
}) => `${event}:${cardId}${MOVE}`
export const lifecycleMove = ({ id }: { id: string }) => id.endsWith(MOVE)

// A question still waiting on Hydra does not count as waiting on the owner.
export function asksOwner({ card }: { card: Card }): boolean {
  return card.attention.some(a => a.blocking && !a.answered)
    || !!card.permissions?.some(p => p.status === 'pending')
    || !!card.asks?.some(a => a.audience === 'owner' && !a.answered)
    || card.status?.state === 'needs_you' || card.status?.state === 'blocked'
}

const DECLARED: Partial<Record<TaskStatus, Stage>> = {
  working: 'in_progress',
  paused: 'parked',
  done: 'done',
}

const ASKED: Partial<Record<TaskStatus, string>> = {
  needs_you: 'Declared needs you',
  blocked: 'Declared blocked',
}

// A turn the server cut short waits for someone to continue it, not for the owner's answer.
const waitsOnOwner = ({ card }: { card: Card }) => asksOwner({
  card: {
    ...card,
    attention: card.attention.filter(a => a.key !== INTERRUPTED),
  },
})

// Only explicit signals count: activity, a finished turn, silence or an ended session never do.
export function lifecycleStage({ card }: { card: Card }): Stage | undefined {
  if (waitsOnOwner({ card })) {
    return 'needs_you'
  }

  return card.status && DECLARED[card.status.state]
}

const moveReason = ({
  card,
  stage,
  answered,
}: {
  card: Card
  stage: Stage | 'queued'
  answered: boolean
}) => {
  if (stage === 'needs_you') {
    return (card.status && ASKED[card.status.state]) ?? 'Waiting for the owner'
  }

  if (answered) {
    return 'Answered'
  }

  if (stage === 'parked') {
    return 'Declared paused'
  }

  return stage === 'done' ? 'Declared done' : 'Declared working'
}

// Only a stage change moves a card, so a manual move holds until the next one.
export function lifecycleMoves({
  before,
  state,
}: {
  before: HydraState
  state: HydraState
}): {
  cardId: string
  column: Column
  reason: string
}[] {
  if (state.config?.hydra.kind === 'firstmate') {
    return []
  }

  const columns = hydraConfig({ state }).columns

  return Object.values(state.cards).flatMap(card => {
    const previous = before.cards[card.id]

    const placed = columns.find(c => c.id === card.column)

    if (!previous || card.automaticTask || card.id === HYDRA_CARD || !placed?.role) {
      return []
    }

    const was = lifecycleStage({ card: previous })
    const answered = was === 'needs_you' && !waitsOnOwner({ card }) && previous.status?.id === card.status?.id
    const back = card.sessionIds?.length ? 'in_progress' : 'queued'
    const stage = lifecycleStage({ card }) ?? (answered && !card.status ? back : undefined)
    const column = stage && stage !== was && roleColumn({
      columns,
      role: stage,
    })

    if (!column || column === card.column) {
      return []
    }

    return [
      {
        cardId: card.id,
        column,
        reason: moveReason({
          card,
          stage,
          answered,
        }),
      },
    ]
  })
}

export function operationDeclarations({
  before,
  state,
  event,
}: {
  before: HydraState
  state: HydraState
  event: HydraEvent
}): {
  cardId: string
  status: TaskStatus
  note: string
  until?: string
  waitingFor?: string[]
  restores?: string
}[] {
  if (state.config?.hydra.kind === 'firstmate') {
    return []
  }

  const changes: ReturnType<typeof operationDeclarations> = []

  const declare = ({
    cardId,
    status,
    note,
  }: {
    cardId: string
    status: TaskStatus
    note: string
  }) => {
    const card = state.cards[cardId]

    if (card && !card.automaticTask && card.id !== HYDRA_CARD) {
      changes.push({
        cardId,
        status,
        note,
      })
    }
  }

  if (event.type === 'task.session') {
    const old = event.data.before && state.cards[event.data.before]

    if (old && old.status?.state !== 'done' && old.status?.state !== 'paused'
      && !asksOwner({ card: old })) {
      declare({
        cardId: old.id,
        status: 'paused',
        note: 'Worker detached',
      })
    }

    if (event.data.after && (event.data.working || event.data.handoff)) {
      declare({
        cardId: event.data.after,
        status: 'working',
        note: 'Worker assigned',
      })
    }
  }

  if (event.type === 'task.launched' && event.data.via === 'command') {
    declare({
      cardId: event.cardId,
      status: 'working',
      note: 'Worker started',
    })
  }

  const card = state.cards[event.cardId]
  const previous = before.cards[event.cardId]

  if (!card || !previous) {
    return changes
  }

  const previousReply = event.type === 'card.replied'
    ? previous.replies?.find(r => r.id === event.data.reply) : undefined
  const deliveredReply = event.type === 'card.replied' && event.data.state === 'delivered'
  const answeredPermission = event.type === 'task.permission'
    && (event.data.status === 'allow' || event.data.status === 'deny')
  const answeredQuestion = event.type === 'hydra.message' && !!event.data.answers
  const answered = deliveredReply || answeredPermission || answeredQuestion
  const waiting = card.status?.waitingFor

  if (answered && waiting?.length && previous.status?.id === card.status?.id) {
    const open = ownerGates({ card })
    const wasOpen = ownerGates({ card: previous })
    const resolved = waiting.some(id => wasOpen.includes(id) && !open.includes(id))

    if (resolved && !waiting.some(id => open.includes(id))) {
      const resume = card.statusLog?.findLast(s => !s.waitingFor?.length)
      changes.push({
        cardId: card.id,
        status: resume?.state ?? (card.sessionIds?.length ? 'working' : 'paused'),
        note: resume?.note ?? 'Owner gate answered',
        until: resume?.until,
        waitingFor: resume?.waitingFor ?? [],
        restores: resume?.restores ?? resume?.id,
      })
    }
  }

  const resumes = event.type === 'card.replied' && (event.data.resumes || previousReply?.resumes)

  if (deliveredReply && previousReply?.state !== 'delivered' && resumes
    && card.status?.state === 'paused' && card.sessionIds?.length && !asksOwner({ card })) {
    declare({
      cardId: card.id,
      status: 'working',
      note: 'Worker resumed by reply',
    })
  }

  return changes
}

export function pausedDeclaration({ card }: { card: Card }) {
  const declaration = card.status

  if (declaration?.state !== 'paused') {
    return undefined
  }

  return card.statusLog?.find(s => s.id === declaration.restores && s.state === 'paused') ?? declaration
}
