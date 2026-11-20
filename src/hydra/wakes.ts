import { sessionFields } from '#workers/session-facts.ts'
import type { HydraState } from '#app/model.ts'
import { decisionsBlock } from '#tasks/decisions.ts'
import { QUIET_REPLY, hydraDelivery, reportActor } from './hydra.ts'
import type { HydraMessage } from './model.ts'
import { clip } from './digest.ts'
import { ownerActor } from '#app/actors.ts'
import { taskMention } from './mentions.ts'
import type { AgentRef } from '#workers/model.ts'
import { readEvents, scanEvents } from '#app/event-log.ts'
import { HYDRA_CARD } from './identity.ts'
import { MAX_RESUMES, resumesInARow } from '#workers/host.ts'
import { sessionId } from '#workers/session-attachments.ts'
import type { HydraChatQueue } from './chat-queue.ts'

// One change Hydra has not read yet: its event and the card it is about.
export interface QueuedUpdate {
  seq: number
  card: string
  kind?: string
}

export interface HydraQueue {
  chat?: HydraChatQueue
  waiting: QueuedUpdate[]
  reading: QueuedUpdate[]
}

// A wake offered again after its turn failed gets a fresh id, as each id starts one turn: wake:<through>.<try>.
export const wakeId = ({
  through,
  state,
}: {
  through: number
  state: HydraState
}) => {
  let id = `wake:${through}`

  for (let attempt = 2; `${id}:hosted` in state.eventIds; attempt += 1) {
    id = `wake:${through}.${attempt}`
  }

  return id
}

export const WAKE_ID = /^wake:(\d+)(?:\.\d+)?$/

// A wake's turn id names the last change it covers; its turn is recorded as `<id>:hosted`.
export const WAKE_TURN = /^wake:(\d+)(?:\.\d+)?:hosted$/

// The finished record of the turn that read a wake carries this id.
export const WAKE_HANDLED = /^wake:(\d+):handled$/

export const REPLY_RULES = [
  'Reply rules: tell the owner at once in plain words with full links when work is ready for review, merged or landed, findings are in, or a failure or blocker cannot be cleared. A decision needed goes on a question card; do not restate it in chat, only add what the card lacks.',
  'A result reply stands alone: say the outcome and what happens next, nothing in between (no running checks, and no retries or re-runs that are under way or passed). Never repeat what waits on the owner; the Waiting on you bar shows it. Say in one sentence when you decide something small under a standing preference.',
  'Answer worker questions already settled by standing preferences. On the second or plainly recurring snag, add one line to the project worker-notes and tell the owner in one sentence.',
].join('\n')

// A worker's words cannot close the wake, or what follows them would reach Hydra outside it.
export const sealed = ({ text }: { text: string }) => text.replace(
  /<\/pnyx-wake/gi,
  '<\\/pnyx-wake',
)

export const decisionsText = ({
  state,
  now,
  pick,
}: {
  state: HydraState
  now: number
  pick?: Parameters<typeof decisionsBlock>[0]['pick']
}) => sealed({
  text: decisionsBlock({
    state,
    now,
    pick,
  }),
})

const WAKE_UPDATE_CHARS = 6000

// Every change wake ends on this, so Hydra never mistakes a result for nothing to say.
const QUIET_RULE = `If none of this needs the owner, reply only ${QUIET_REPLY}. A result (ready for review, merged, findings, or a failure or blocker you cannot clear, including a failed retry the owner must act on) always gets a reply.`

export function wakeText({
  hydraId,
  state,
  now,
  after,
  reasons,
  reports,
  check,
  review,
  pick,
}: {
  hydraId: string
  state: HydraState
  now: number
  after: number
  reasons: string[]
  reports: HydraMessage[]
  check: boolean
  review?: string
  pick?: Parameters<typeof decisionsText>[0]['pick']
}): string {
  const lines: string[] = []
  let overflow = false
  let reviewOverflow = false
  let used = 0

  if (reasons.length) {
    const heading = 'Why you are woken:'
    lines.push(heading)
    used = heading.length + 1

    for (const reason of reasons) {
      const escaped = sealed({ text: reason })

      if (!pick && used + escaped.length + 1 > WAKE_UPDATE_CHARS) {
        overflow = true
        continue
      }

      lines.push(escaped)
      used += escaped.length + 1
    }
  }

  if (reports.length) {
    const count = reports.length === 1 ? 'A worker report' : `${reports.length} worker reports`
    const notice = pick
      ? `${count} arrived while you were busy. Handle them together and answer once.`
      : `${count} arrived while you were busy.`

    if (pick || used + notice.length + 1 <= WAKE_UPDATE_CHARS) {
      lines.push(notice)
      used += notice.length + 1
    } else {
      overflow = true
    }

    if (pick) {
      for (const message of reports) {
        lines.push(sealed({ text: hydraDelivery({ message }) }))
      }
    }
  }

  if (review) {
    const reviewText = sealed({ text: review })
    const remaining = WAKE_UPDATE_CHARS - used - 1

    if (pick || reviewText.length <= remaining) {
      lines.push(reviewText)
    } else {
      overflow = true

      if (remaining > 1) {
        lines.push(clip({
          text: reviewText,
          size: remaining,
        }))
      }

      reviewOverflow = true
    }
  }

  if (overflow) {
    lines.push('Some wake details were shortened or omitted.')
  }

  if (pick && check) {
    lines.push(`Run \`pnyx-axi hydra check --after ${after} --hydra ${hydraId}\` for the details and every other change, and handle what it lists.`)
  } else if (check || overflow) {
    lines.push(`Run \`pnyx-axi hydra check --after ${after} --hydra ${hydraId}\` for the details and every other change. Follow its \`through\` cursor when it offers another page. Act on pending reports marked unhandled when they need you.`)
  }

  if (reviewOverflow) {
    const reviewedThrough = state.hydraReview?.seq ?? state.seq
    lines.push(`Read \`pnyx-axi history --kind hydra.review --before ${reviewedThrough + 1} --limit 1 --full --hydra ${hydraId}\` for the full timed-review details.`)
  }

  lines.push(decisionsText({
    state,
    now,
    pick,
  }))
  lines.push(QUIET_RULE)
  lines.push(REPLY_RULES)

  return `<pnyx-wake>${lines.join('\n')}</pnyx-wake>`
}

export const outageMinutes = ({
  since,
  now,
}: {
  since: string
  now: number
}) => Math.max(
  1,
  Math.round((now - Date.parse(since)) / 60_000),
)

// The first turn after Hydra could not start: the owner's messages no turn took, and how much more waits for the next wake.
// carried names the owner's messages the text lists, which Hydra takes with it.
export function recapText({
  state,
  since,
  after,
  now,
  why,
}: {
  state: HydraState
  since: string
  after: number
  now: number
  // Why Hydra was stopped; an outage when not given.
  why?: string
}): {
  text: string
  carried: string[]
} {
  const minutes = outageMinutes({
    since,
    now,
  })
  const sent = (state.hydraMessages ?? []).filter(message =>
    (state.eventIds[message.id] ?? 0) > after)
  // A message whose turn started has been read; worker reports reach Hydra in their own wake.
  const unread = sent.filter(message => !message.stopped && ownerActor({ actor: message.actor })
    && !(`${message.id}:hosted` in state.eventIds))
  const unreadLines = unread.map(message => {
    const card = message.task ? state.cards[message.task] : undefined
    const task = card ? ` on ${taskMention({
      id: card.id,
      title: card.title,
    })}` : ''

    return `- ${message.at}${task}:\n${sealed({ text: message.text })}`
  })
  const reports = sent.filter(message => reportActor({ actor: message.actor }) && message.kind !== 'progress').length

  const text = `<pnyx-wake>${[
    why ?? `Why you are woken: back after outage. Pnyx could not start you from ${since} until now (${minutes} min).`,
    ...unreadLines.length ? [
      'The owner wrote to you meanwhile and has had no reply; answer these:',
      ...unreadLines,
    ] : ['The owner sent you nothing meanwhile.'],
    ...reports ? [`${reports === 1 ? 'A worker report' : `${reports} worker reports`} and any other changes from meanwhile reach you in your next wake.`] : [],
    decisionsText({
      state,
      now,
    }),
    `If none of this needs the owner, reply only ${QUIET_REPLY}.`,
    REPLY_RULES,
  ].join('\n')}</pnyx-wake>`

  return {
    text,
    carried: unread.map(message => message.id),
  }
}

// The highest change a wake id matching pattern covers, or 0.
export function wakesThrough({
  state,
  pattern,
}: {
  state: HydraState
  pattern: RegExp
}): number {
  const covered = Object.keys(state.eventIds).flatMap(id => pattern.exec(id)?.[1] ?? [])
    .map(Number)

  return Math.max(
    0,
    ...covered,
  )
}

// A wake counts once the turn that read it finishes, so a failed turn's updates are offered again.
export function wakeCursor({
  state,
  fallback,
}: {
  state: HydraState
  fallback: number
}): number {
  const handled = wakesThrough({
    state,
    pattern: WAKE_HANDLED,
  })

  if (handled > 0) {
    return handled
  }

  return fallback
}

export function findHydraTurnToResume({
  hydraId,
  state,
  agent,
}: {
  hydraId: string
  state: HydraState
  agent: AgentRef
}): {
  resumeAttemptId: string
  resumeMessage: string
  wakeThrough: number
} | undefined {
  const cutHydraTurn = scanEvents({
    hydraId,
    cardId: HYDRA_CARD,
    types: [
      'hydra.delivered',
      'board.configured',
    ],
    descending: true,
  }).find(event => {
    if (event.cardId !== HYDRA_CARD || !event.id.endsWith(':hosted')) {
      return false
    }

    return event.type === 'hydra.delivered'
      ? event.data.session === sessionId({ agent })
      : event.type === 'board.configured' && event.data.hydra?.session === sessionId({ agent })
  })

  if (!cutHydraTurn || resumesInARow({
    turn: cutHydraTurn,
    read: ({ seq }) => readEvents({
      hydraId,
      seqs: [seq],
    })[0],
  }) >= MAX_RESUMES) {
    return undefined
  }

  const resumeAttemptId = `resume:${cutHydraTurn.seq}`

  if (resumeAttemptId in state.eventIds) {
    return undefined
  }

  const lastFinishedTurn = scanEvents({
    hydraId,
    cardId: HYDRA_CARD,
    types: [
      'card.pushed',
      'session.observed',
    ],
    before: cutHydraTurn.seq,
    descending: true,
  }).find(event => {
    const fields = sessionFields({ event })

    return fields?.activity === 'finished' && event.actor === 'pnyx'
      && fields.agent?.sessionId === agent.sessionId && fields.agent.provider === agent.provider
  })
  const sourceId = cutHydraTurn.id.replace(
    /:compact:hosted$|:hosted$/,
    '',
  )
  const source = readEvents({
    hydraId,
    types: ['hydra.message'],
    ids: [sourceId],
  })[0]
  const lastFinishedTurnSeq = Math.min(
    lastFinishedTurn?.seq ?? 0,
    source ? source.seq - 1 : Infinity,
  )
  const unansweredMessages: number[] = []

  for (const event of scanEvents({
    hydraId,
    types: ['hydra.message'],
    after: lastFinishedTurnSeq,
  })) {
    if (event.type !== 'hydra.message' || !ownerActor({ actor: event.actor })) {
      continue
    }

    unansweredMessages.push(event.seq)
  }

  const wakeThroughSeq = WAKE_TURN.exec(cutHydraTurn.id)?.[1]
  const isStallCheck = /^(stall|wait|unconfirmed):/.test(cutHydraTurn.id)
  const unfinishedWork: string[] = []

  if (unansweredMessages.length) {
    unfinishedWork.push('the owner messages listed below')
  }

  if (wakeThroughSeq) {
    const wakeCheckPhrase = `a wake check through seq ${wakeThroughSeq}`
    unfinishedWork.push(wakeCheckPhrase)
  }

  if (isStallCheck) {
    const stallCheckPhrase = 'a stall check'
    unfinishedWork.push(stallCheckPhrase)
  }

  const interruptedWork = unfinishedWork.join(' and ') || 'a turn'
  const ownerReads = unansweredMessages.map(seq =>
    `Read owner message ${seq} in full with \`pnyx-axi hydra messages --after ${seq - 1} --limit 1 --hydra ${hydraId}\`.`)

  return {
    resumeAttemptId,
    wakeThrough: Number(wakeThroughSeq ?? 0),
    resumeMessage: `<pnyx-wake>A Pnyx server restart cut your last turn before you answered ${interruptedWork}. Run \`pnyx-axi hydra check --after ${lastFinishedTurnSeq} --hydra ${hydraId}\` and follow its \`through\` cursor. Use \`pnyx-axi hydra messages --after <seq minus one> --limit 1 --hydra ${hydraId}\` when you need a specific message in full. Answer what is still open and tell the owner in one line that the restart cut your reply.\n${[
      ...ownerReads,
      decisionsText({
        state,
        now: Date.now(),
      }),
    ].join('\n')}\n${REPLY_RULES}</pnyx-wake>`,
  }
}
