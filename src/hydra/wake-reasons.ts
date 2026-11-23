import { agentActivity } from '#workers/activity.ts'
import { projectedAttention, sessionTask } from '#workers/session-attachments.ts'
import { taskReadiness } from '#tasks/dependencies.ts'
import { mergeApproval } from '#tasks/delivery/merge-questions.ts'
import { clip } from './digest.ts'
import { unwatchedPullRequests } from '#tasks/delivery/following.ts'
import { agentActor, hostedHydra, pnyxRunsHydra, reportActor } from './hydra.ts'
import { HYDRA_CARD } from './identity.ts'
import { HYDRA_ACTOR } from '#app/actors.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { Card, PushedEvent } from '#tasks/model.ts'
import { cardLanding, failedChecks, pendingChecks, ranChecks, type Link } from '#tasks/delivery/model.ts'
import { rankOf } from '#tasks/select.ts'
import { taskMention } from './mentions.ts'

export type WakeKind = 'declared' | 'asked' | 'report' | 'turn ended' | 'checks' | 'comments' | 'merged'
  | 'approved merge is green' | 'quiet' | 'wait ended' | 'not confirmed' | 'reminder due' | 'queue released'
  | 'instruction unread' | 'prerequisite' | 'queued' | 'kind' | 'permission' | 'slot free' | 'timed review'
  | 'project refresh'

export interface WakeReason {
  kind: WakeKind
  card?: string
  detail?: string
}

const QUOTE_CHARS = 200

// One line: "- [@Title](pnyx-task:id) kind: detail", the task left out when the fact names none.
export function reasonLine({
  state,
  card,
  kind,
  detail,
}: WakeReason & { state: HydraState }): string {
  const task = card ? state.cards[card] : undefined
  const ref = task ? `${taskMention({
    id: task.id,
    title: task.title,
  })} ` : ''

  return `- ${ref}${kind}${detail ? `: ${detail}` : ''}`
}

export const quote = ({ text }: { text: string }) => `"${clip({
  text,
  size: QUOTE_CHARS,
})}"`

// Every check on an open, ready pull request has finished, and the result or the readiness is new.
function checksSettled({
  before,
  after,
}: {
  before: Link | null
  after: Link
}): boolean {
  const ready = after.state === 'open' && !after.draft
  const changed = after.checks !== before?.checks || Boolean(before?.draft) || before?.state !== 'open'

  const { checks } = after
  const finished = ranChecks({ checks }) && pendingChecks({ checks }) === 0

  return ready && changed && finished
}

// Backlog cards a free worker could take: no worker yet, not queued behind one, not held, and nothing waiting on the owner.
export function readyBacklog({ state }: { state: HydraState }): Card[] {
  return Object.values(state.cards).filter(card => !card.hidden)
    .sort((
      a,
      b,
    ) => rankOf({ card: a }) - rankOf({ card: b }))
    .filter(card => {
      const started = card.agent || card.sessionIds?.length || card.queue

      return card.id !== HYDRA_CARD && !started && card.workerLog?.status?.code !== 'done' && taskReadiness({
        state,
        card,
      }).ready
    })
}

function slotFree({ state }: { state: HydraState }): WakeReason[] {
  const ready = readyBacklog({ state })

  if (!ready.length) {
    return []
  }

  const list = ready.map(card => taskMention({
    id: card.id,
    title: card.title,
  })).join(', ')

  return [
    {
      kind: 'slot free',
      detail: `ready in Backlog, in order: ${list}`,
    },
  ]
}

export function mergeApproved({
  state,
  card,
  url,
}: {
  state: HydraState
  card: Card
  url?: string
}): boolean {
  if (agentActivity({
    card,
    cards: state.cards,
    sessions: state.sessions,
  }) === 'working') {
    return false
  }

  if (url !== undefined && mergeApproval({
    state,
    card,
    url,
  })) {
    return true
  }

  const rule = cardLanding({
    card,
    projects: state.projects ?? [],
  })

  return rule?.merge === 'hydra'
}

const checksDetail = ({ link }: { link: Link }) =>
  `${link.url} ${failedChecks({ checks: link.checks }) ? 'red' : 'green'} (${link.checks})`

// A merge or settled checks need Hydra; failed checks and new comments go to the task's worker, so they need Hydra only when no worker can be woken.
function linkReasons({
  state,
  card,
  before,
  after,
}: {
  state: HydraState
  card: Card
  before: Link | null
  after: Link | null
}): WakeReason[] {
  if (after?.kind !== 'github_pr') {
    return []
  }

  if (after.state === 'merged') {
    return before?.state === 'merged' ? [] : [
      {
        kind: 'merged',
        card: card.id,
        detail: after.url,
      },
    ]
  }

  const unwatched = unwatchedPullRequests({ card }).length > 0
  const failed = failedChecks({ checks: after.checks })
  const reasons: WakeReason[] = []

  if (checksSettled({
    before,
    after,
  })) {
    if (!failed && mergeApproved({
      state,
      card,
      url: after.url,
    })) {
      reasons.push({
        kind: 'approved merge is green',
        card: card.id,
        detail: `${after.url} (${after.checks})`,
      })
    } else {
      reasons.push({
        kind: 'checks',
        card: card.id,
        detail: checksDetail({ link: after }),
      })
    }
  } else if (unwatched && failed > failedChecks({ checks: before?.checks })) {
    reasons.push({
      kind: 'checks',
      card: card.id,
      detail: `${checksDetail({ link: after })}, and no worker watches it`,
    })
  }

  const comments = before?.comments === undefined ? 0 : (after.comments ?? 0) - before.comments

  if (unwatched && comments > 0) {
    reasons.push({
      kind: 'comments',
      card: card.id,
      detail: `${comments} new on ${after.url}, and no worker watches it`,
    })
  }

  return reasons
}

// A worker's new question, a working turn it ended without saying why, or a session that ended with its pull request unwatched.
function pushReasons({
  card,
  event,
}: {
  card: Card
  event: PushedEvent
}): WakeReason[] {
  const {
    before,
    attention,
    activity,
  } = event.data
  const open = ({ list }: { list?: Card['attention'] }) => (list ?? []).filter(a => a.blocking && !a.answered)
  const asked = open({ list: before?.attention }).map(a => a.key)
  const pending = new Set(open({ list: card.attention }).map(a => a.key))
  // A push that first reports attention has nothing earlier to compare against.
  const questions = before?.attention
    ? open({ list: attention }).filter(a => !asked.includes(a.key) && pending.has(a.key))
    : []
  const reasons: WakeReason[] = questions.map(a => ({
    kind: 'asked',
    card: card.id,
    detail: `${a.key}: ${quote({ text: a.text ?? a.questions?.map(q => q.question).join(' ') ?? a.kind })}`,
  }))
  const unwatched = unwatchedPullRequests({ card })

  if (activity === 'ended' && unwatched.length) {
    reasons.push({
      kind: 'turn ended',
      card: card.id,
      detail: `the worker's session ended, and no worker watches ${unwatched.map(l => l.url).join(', ')}`,
    })
  }

  return reasons
}

// The facts in one change that need a hosted Hydra's judgment; never Hydra's own writes or card.
function ordinaryReasons({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): WakeReason[] {
  if (event.actor.startsWith('helper:')) {
    return []
  }

  if (event.type === 'hydra.review') {
    return event.data.wake !== false && pnyxRunsHydra({ state }) ? [{ kind: 'timed review' }] : []
  }

  if (event.type === 'task.session' && event.data.before && !event.data.after && hostedHydra({ state })) {
    return slotFree({ state })
  }

  // A worker's report starts a Hydra Pnyx has not run yet, whatever card it names.
  if (event.type === 'hydra.message') {
    const {
      task,
      ask,
      text,
    } = event.data

    const card = task ? state.cards[task] : undefined
    const approved = card?.asks?.find(a => a.id === ask || a.id === event.data.answers)
    const link = card?.links.find(l => l.url === approved?.url)

    const runsHere = pnyxRunsHydra({ state })

    if (runsHere && card && link && approved?.answered === event.id && mergeApproval({
      state,
      card,
      url: link.url,
    })
      && link.state === 'open' && link.draft === false && ranChecks({ checks: link.checks })
      && !failedChecks({ checks: link.checks }) && !pendingChecks({ checks: link.checks })) {
      return [
        {
          kind: 'approved merge is green',
          card: card.id,
          detail: `${link.url} (${link.checks})`,
        },
      ]
    }

    if (!reportActor({ actor: event.actor }) || !pnyxRunsHydra({ state })) {
      return []
    }

    const question = task ? state.cards[task]?.asks?.find(a => a.id === ask)?.question : undefined

    return [
      ask ? {
        kind: 'asked',
        card: task,
        detail: `${ask}: ${quote({ text: question ?? text })}`,
      } : {
        kind: 'report',
        card: task,
        detail: `from ${event.actor}, in the since-last-turn report lines`,
      },
    ]
  }

  const card = state.cards[event.cardId]

  if (event.type === 'task.source.alerted' && card && pnyxRunsHydra({ state })) {
    return [
      {
        kind: 'not confirmed',
        card: card.id,
        detail: event.data.detail,
      },
    ]
  }

  if (event.actor === HYDRA_ACTOR || event.cardId === HYDRA_CARD || !card
    || !hostedHydra({ state })) {
    return []
  }

  switch (event.type) {
    case 'project.refreshed':
      return event.data.state === 'needs-attention' || event.data.state === 'unknown' ? [
        {
          kind: 'project refresh',
          card: card.id,
          detail: `${event.data.path}: ${event.data.reason}. The pull request remains confirmed merged.`,
        },
      ] : []
    case 'task.worker-line': {
      const {
        code,
        text,
      } = event.data

      return [
        'needs-you',
        'blocked',
        'done',
      ].includes(code) ? [
          {
            kind: 'declared',
            card: card.id,
            detail: `${code}: ${text}`,
          },
        ] : []
    }
    case 'task.permission':
      return event.data.status === 'pending' ? [
        {
          kind: 'permission',
          card: card.id,
          detail: `${event.data.tool} waits for an answer`,
        },
      ] : []
    case 'task.reminder-due':
      return event.data.grouped ? [] : [
        {
          kind: 'reminder due',
          card: card.id,
          detail: clip({
            text: event.data.reminder,
            size: QUOTE_CHARS,
          }),
        },
      ]
    case 'task.queue':
      return [
        event.data.after ? {
          kind: 'queued',
          card: card.id,
          detail: `behind ${event.data.after.session}`,
        } : {
          kind: 'queue released',
          card: card.id,
        },
      ]
    case 'task.kind':
      return [
        {
          kind: 'kind',
          card: card.id,
          detail: `${event.data.before} to ${event.data.after}`,
        },
      ]
    case 'card.linked':
      return linkReasons({
        state,
        card,
        before: event.data.before,
        after: event.data.after,
      })
    case 'task.edited':
      return agentActor({ actor: event.actor }) ? pushReasons({
        card,
        event,
      }) : []
    default:
      return []
  }
}

function changesReadiness({
  event,
}: {
  event: HydraEvent
}): boolean {
  switch (event.type) {
    case 'card.linked':
      return Boolean(event.data.before) !== Boolean(event.data.after)
        || event.data.before?.state !== event.data.after?.state
    case 'card.outcome':
      return Boolean(event.undoes) || event.data.before?.state !== event.data.after?.state
        || event.data.before?.closed !== event.data.after?.closed
    case 'task.edited': {
      if (!event.data.attention) {
        return false
      }

      const blocking = ({ attention }: { attention?: Card['attention'] }) => (attention ?? [])
        .filter(item => item.blocking && !item.answered).map(item => item.key)
        .sort()
        .join(',')

      const beforeBlocking = blocking({ attention: event.data.before?.attention })
      const afterBlocking = blocking({ attention: event.data.attention })

      return beforeBlocking !== afterBlocking
    }
    case 'hydra.message':
      return Boolean(event.data.answers)
    case 'card.replied':
      return event.data.accepted === true
        || (event.data.state === 'delivered' && Boolean(event.data.answers || event.data.decision))
    case 'task.dependencies':
    case 'task.held':
    case 'task.released':
    case 'task.kind':
    case 'task.report':
    case 'task.report-reviewed':
    case 'task.landing':
    case 'task.project':
    case 'task.asked':
    case 'task.ask.closed':
    case 'task.ask.deferred':
    case 'task.ask.reopened':
    case 'task.permission':
      return true
    default:
      return false
  }
}

export function eventReasons({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): WakeReason[] {
  if (event.type === 'session.observed') {
    if (!('fields' in event.data) || event.data.cursor) {
      return []
    }

    const card = sessionTask({
      state,
      agent: event.data.fields.agent,
    })

    if (!card || card.id !== event.cardId) {
      return []
    }

    return eventReasons({
      state,
      event: {
        ...event,
        type: 'task.edited',
        data: {
          ...event.data.fields,
          key: card.key,
          attention: event.data.fields.attention && projectedAttention({
            agent: event.data.fields.agent,
            attention: event.data.fields.attention,
          }),
          before: event.data.before,
        },
      },
    })
  }

  if (event.type === 'task.steering.recovery' && event.data.recovery.result === 'exhausted') {
    const card = state.cards[event.cardId]
    const message = card?.steering?.find(message => message.id === event.data.message)

    if (!message || message.ack || card?.hidden) {
      return []
    }

    return [
      {
        kind: 'instruction unread',
        card: event.cardId,
        detail: `instruction ${message.id} remains unread: ${event.data.recovery.detail}. Read it in tasks/${event.cardId}/task.log; review the worker route or hold before resuming`,
      },
    ]
  }

  const reasons = ordinaryReasons({
    state,
    event,
  })

  if (!hostedHydra({ state }) || !changesReadiness({
    event,
  })) {
    return reasons
  }

  const affected = event.type === 'hydra.message' ? event.data.task : event.cardId

  if (!affected) {
    return reasons
  }

  const dependsOnChange = ({
    card,
    visited,
  }: {
    card: Card
    visited: Set<string>
  }): boolean => {
    if (visited.has(card.id)) {
      return false
    }

    visited.add(card.id)

    return (card.prerequisites ?? []).some(id => id === affected
      || Boolean(state.cards[id] && dependsOnChange({
        card: state.cards[id],
        visited,
      })))
  }

  for (const card of Object.values(state.cards)) {
    const changedOwnReadiness = card.id === affected
      && (event.type === 'task.dependencies' || Boolean(card.prerequisites?.length))

    if (card.hidden || (!changedOwnReadiness && !dependsOnChange({
      card,
      visited: new Set(),
    }))) {
      continue
    }

    const readiness = taskReadiness({
      state,
      card,
    })
    const assigned = Boolean(card.sessionIds?.length || card.agent)
    let detail = 'prerequisites cleared; ready for dispatch'

    if (!readiness.ready) {
      detail = readiness.reasons.join('; ')

      if (assigned && card.workerLog?.status?.code !== 'done') {
        detail += '; worker already assigned, Hydra must review'
      }
    } else if (assigned || card.workerLog?.status?.code === 'done') {
      continue
    }

    reasons.push({
      kind: 'prerequisite',
      card: card.id,
      detail,
    })
  }

  return reasons
}

// Why Hydra is woken by these changes: one line per fact, oldest first, each fact once.
export function wakeReasons({
  state,
  events,
}: {
  state: HydraState
  events: HydraEvent[]
}): string[] {
  const lines = events.flatMap(event => eventReasons({
    state,
    event,
  })).map(reason => reasonLine({
    state,
    ...reason,
  }))

  return [...new Set(lines)]
}
