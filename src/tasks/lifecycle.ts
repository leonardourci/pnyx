import { ownerGates } from './owner-gates.ts'
import type { HydraEvent, HydraState } from '../app/model.ts'
import type { Column } from './columns-model.ts'
import type { Card, TaskStatus } from './model.ts'
import { HYDRA_CARD } from '../hydra/identity.ts'
import { hydraConfig } from '../hydra/config.ts'
import { cardFacts, placeCard } from './columns.ts'

type Stage = 'queued' | 'in_progress' | 'needs_you' | 'parked' | 'done'

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
  return ownerGates({ card }).length > 0 || !!card.reminder?.dueAt
}

const moveReason = ({
  stage,
  answered,
  facts,
}: {
  facts: ReturnType<typeof cardFacts>
  stage: Stage
  answered: boolean
}) => {
  if (stage === 'needs_you') {
    return 'Waiting for the owner'
  }

  if (answered) {
    return 'Answered'
  }

  if (stage === 'queued') {
    if (facts.includes('held')) {
      return 'Held for discussion'
    }

    return facts.includes('queued') ? 'Queued behind a worker' : 'Waiting for a worker'
  }

  if (stage === 'parked') {
    return facts.includes('worker:ended') ? 'Worker ended with unfinished work' : 'Declared paused'
  }

  return stage === 'done' ? 'Declared done' : 'Declared working'
}

// A manual move holds until a change selects a different rule destination.
export function lifecycleMoves({
  before,
  state,
  event,
}: {
  before: HydraState
  state: HydraState
  event?: HydraEvent
}): {
  cardId: string
  column: Column
  reason: string
}[] {
  const migrating = event?.type === 'board.columns' && event.actor === 'pnyx'

  if (state.config?.hydra.kind === 'firstmate' || migrating) {
    return []
  }

  const columns = hydraConfig({ state }).columns

  return Object.values(state.cards).flatMap(card => {
    const previous = before.cards[card.id]

    const unmanaged = !state.configured && card.tracking !== 'declared'

    if (card.automaticTask || card.id === HYDRA_CARD || unmanaged
      || (!previous && event?.type !== 'task.created')) {
      return []
    }

    if (event?.type === 'board.columns' && event.data.placements?.[card.id]) {
      return []
    }

    if (!previous && event?.type === 'task.created' && event.data.column && !card.hold) {
      return []
    }

    const facts = cardFacts({
      card,
      state,
    })
    const column = placeCard({
      card: facts,
      columns,
    })
    const previousColumn = previous && placeCard({
      card: cardFacts({
        card: previous,
        state: before,
      }),
      columns: hydraConfig({ state: before }).columns,
    })

    if (!column || column === card.column || column === previousColumn) {
      return []
    }

    const answered = !!previous && asksOwner({ card: previous }) && !asksOwner({ card })
    const destination = columns.find(c => c.id === column)!
    const stage = destination.role
    const reason = stage && stage !== 'workers_on_it'
      ? moveReason({
        stage,
        answered,
        facts,
      }) : `Column rule matched: ${destination.title}`

    return [
      {
        cardId: card.id,
        column,
        reason,
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

  if (event.type === 'task.asked' && event.data.kind === 'merge') {
    changes.push({
      cardId: card.id,
      status: 'needs_you',
      note: `Pull request ready for owner review: ${event.data.url}`,
      waitingFor: ownerGates({ card }),
    })
  }

  const previousReply = event.type === 'card.replied'
    ? previous.replies?.find(r => r.id === event.data.reply) : undefined
  const deliveredReply = event.type === 'card.replied' && event.data.state === 'delivered'
  const answeredPermission = event.type === 'task.permission'
    && (event.data.status === 'allow' || event.data.status === 'deny')
  const answeredQuestion = (event.type === 'hydra.message' && !!event.data.answers) || event.type === 'task.ask.closed'
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
