import { mergeApproval } from './asks.ts'
import { clip } from './digest.ts'
import { openAsks } from './asks.ts'
import { ownerGates } from './gates.ts'
import { agentActor, HYDRA_CARD, hostedHydra, hydraConfig, pnyxRunsHydra, reportActor, roleColumn, unwatchedPullRequests } from './hydra.ts'
import { cardLanding, failedChecks, HYDRA_ACTOR, pendingChecks, ranChecks, type Card, type HydraEvent, type HydraState, type Link, type PushedEvent, type TaskStatus } from './model.ts'
import { columnCards } from './tasks.ts'
import { taskMention } from '../mentions/mentions.ts'

// The fixed words a reason line names its fact with; the pnyx-hydra skill and the README list them.
export type WakeKind = 'declared' | 'asked' | 'report' | 'turn ended' | 'checks' | 'comments' | 'merged'
  | 'approved merge is green' | 'quiet' | 'wait ended' | 'not confirmed' | 'reminder due' | 'queue released'
  | 'queued' | 'kind' | 'permission' | 'slot free' | 'timed review'

export interface WakeReason {
  kind: WakeKind
  card?: string
  detail?: string
}

// How much of a worker's own words a reason line quotes; the full text is on the card and in hydra check.
const QUOTE_CHARS = 200

// Declarations that need Hydra's judgment; working and paused stay on the card until its next check.
const WAKING_STATES: TaskStatus[] = [
  'needs_you',
  'blocked',
  'done',
]

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

const onHold = ({ card }: { card: Card }) => card.status?.state === 'paused' && card.status.hold === true

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
  const column = roleColumn({
    columns: hydraConfig({ state }).columns,
    role: 'queued',
  })

  if (!column) {
    return []
  }

  return columnCards({
    state,
    column,
  }).filter(card => {
    const started = card.agent || card.sessionIds?.length || card.queue

    return card.id !== HYDRA_CARD && !started && !card.hold && !onHold({ card }) && card.status?.state !== 'done'
      && !ownerGates({ card }).length && !openAsks({ card }).length
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
  if (url !== undefined && mergeApproval({
    card,
    url,
  })) {
    return true
  }

  const rule = cardLanding({
    card,
    projects: state.projects ?? [],
  })

  return card.status?.state !== 'working' && rule?.merge === 'hydra'
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
  // A push that first reports attention has nothing earlier to compare against.
  const questions = before?.attention
    ? open({ list: attention }).filter(a => !asked.includes(a.key))
    : []
  const reasons: WakeReason[] = questions.map(a => ({
    kind: 'asked',
    card: card.id,
    detail: `${a.key}: ${quote({ text: a.text ?? a.questions?.map(q => q.question).join(' ') ?? a.kind })}`,
  }))
  const asking = card.attention.some(a => a.blocking && !a.answered)
  const silent = !card.status || card.status.state === 'working'

  if (activity === 'finished' && card.turnEndedSeq === event.seq && silent && !asking) {
    reasons.push({
      kind: 'turn ended',
      card: card.id,
      detail: card.status
        ? 'the worker finished its turn still declaring working'
        : 'the worker finished its turn without declaring anything',
    })
  }

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
function eventReasons({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): WakeReason[] {
  if (event.type === 'hydra.review') {
    return pnyxRunsHydra({ state }) ? [{ kind: 'timed review' }] : []
  }

  if (event.type === 'task.session' && event.data.before && !event.data.after && hostedHydra({ state })) {
    return slotFree({ state })
  }

  // A worker's report starts a Hydra Pnyx has not run yet, whatever card it names; a progress report only joins the next wake.
  if (event.type === 'hydra.message') {
    const {
      task,
      ask,
      text,
      kind,
    } = event.data

    const card = task ? state.cards[task] : undefined
    const approved = card?.asks?.find(a => a.id === ask || a.id === event.data.answers)
    const link = card?.links.find(l => l.url === approved?.url)

    const runsHere = pnyxRunsHydra({ state })

    if (runsHere && card && link && approved?.answered === event.id && mergeApproval({
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

    if (!reportActor({ actor: event.actor }) || kind === 'progress' || !pnyxRunsHydra({ state })) {
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
        detail: `from ${event.actor}, in its envelope below`,
      },
    ]
  }

  const card = state.cards[event.cardId]

  if (event.actor === HYDRA_ACTOR || event.cardId === HYDRA_CARD || !card || card.automaticTask
    || !hostedHydra({ state })) {
    return []
  }

  switch (event.type) {
    case 'task.declared': {
      const {
        state: declared,
        note,
      } = event.data

      if (!WAKING_STATES.includes(declared)) {
        return []
      }

      const reasons: WakeReason[] = [
        {
          kind: 'declared',
          card: card.id,
          detail: note ? `${declared}, ${quote({ text: note })}` : declared,
        },
      ]

      if (declared === 'done') {
        reasons.push(...slotFree({ state }))
      }

      return reasons
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
      return [
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
    case 'card.pushed':
      return card.tracking === 'declared' && agentActor({ actor: event.actor }) ? pushReasons({
        card,
        event,
      }) : []
    default:
      return []
  }
}

// A change wakes a hosted Hydra for a check turn exactly when it has a reason to give.
export function wakesHydra({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  return eventReasons({
    state,
    event,
  }).length > 0
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
