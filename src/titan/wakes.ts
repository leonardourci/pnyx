import { dirname } from 'node:path'
import { contextReportStatus, contextTurnNotes } from './context-notes.ts'
import { recordContext, recordFiles } from './file-context.ts'
import { WAKE_TURN, WAKE_HANDLED } from './wake-ids.ts'
import { sessionFields } from '#workers/session-facts.ts'
import type { TitanState } from '#app/model.ts'
import { decisionsBlock } from '#tasks/decisions.ts'
import { QUIET_REPLY, titanDelivery, reportActor } from './titan.ts'
import type { TitanMessage } from './model.ts'
import { clip } from './digest.ts'
import { ownerActor } from '#app/actors.ts'
import { taskMention } from './mentions.ts'
import type { AgentRef } from '#workers/model.ts'
import { readChanges, scanChanges } from '#app/event-log.ts'
import { TITAN_CARD } from './identity.ts'
import { MAX_RESUMES, resumesInARow } from '#workers/host.ts'
import { titanInputDispatched } from './received.ts'
import { sessionId } from '#workers/session-attachments.ts'
import type { TitanChatQueue } from './chat-queue.ts'

// One change Titan has not read yet: its event and the card it is about.
export interface QueuedUpdate {
  seq: number
  card: string
  kind?: string
}

export interface TitanQueue {
  chat?: TitanChatQueue
  waiting: QueuedUpdate[]
  reading: QueuedUpdate[]
}

export const REPLY_RULES = [
  'Reply rules: tell the owner at once in plain words with full links when work is ready for review, merged or landed, findings are in, or a failure or blocker cannot be cleared. A decision needed goes on a question card; do not restate it in chat, only add what the card lacks.',
  'A result reply stands alone: say the outcome and what happens next, nothing in between (no running checks, and no retries or re-runs that are under way or passed). Never repeat what waits on the owner; the Waiting on you bar shows it. Say in one sentence when you decide something small under a standing preference.',
  'Answer worker questions already settled by standing preferences. On the second or plainly recurring snag, add one line to the project worker-notes and tell the owner in one sentence.',
].join('\n')

// A worker's words cannot close the wake, or what follows them would reach Titan outside it.
export const sealed = ({ text }: { text: string }) => text.replace(
  /<\/othrys-wake/gi,
  '<\\/othrys-wake',
)

export const decisionsText = ({
  state,
  now,
  pick,
}: {
  state: TitanState
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

// Every change wake ends on this, so Titan never mistakes a result for nothing to say.
const QUIET_RULE = `If none of this needs the owner, reply only ${QUIET_REPLY}. A result (ready for review, merged, findings, or a failure or blocker you cannot clear, including a failed retry the owner must act on) always gets a reply.`

export function wakeText({
  titanId,
  state,
  now,
  reasons,
  reports,
  check,
  review,
  reviewId,
  reportSeqs,
  pick,
}: {
  titanId: string
  state: TitanState
  now: number
  reasons: string[]
  reports: TitanMessage[]
  check: boolean
  review?: string
  reviewId?: string
  reportSeqs?: number[]
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
        lines.push(sealed({ text: titanDelivery({ message }) }))
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

  if (check || overflow || reviewOverflow) {
    const notes = state.contextNotes ?? []
    const supplied = pick ? notes : contextTurnNotes({ notes })
    const pending = supplied.filter(note => {
      if (!note.report || note.handled) {
        return false
      }

      return pick ? pick.tasks?.includes(note.task ?? '') && reportSeqs?.includes(note.seq)
        : contextReportStatus({
          state,
          note,
        }) === 'unhandled'
    })
    const scope = pick ? 'Only handle the granted tasks and selected updates listed below.'
      : 'Act on these pending reports when they need you.'
    lines.push(`Read native records under ${JSON.stringify(dirname(recordFiles({ titanId }).titan))}. ${scope}`)

    const pendingEvents = new Map<string, string>()

    if (pending.length) {
      const first = Math.min(...pending.map(note => note.seq))
      const last = Math.max(...pending.map(note => note.seq))
      const ids = new Set(pending.map(note => note.id))

      for (const event of scanChanges({
        titanId,
        after: first - 1,
      })) {
        if (event.seq > last) {
          break
        }

        if (ids.has(event.id)) {
          const file = event.type === 'titan.message' || event.cardId === TITAN_CARD
            ? 'titan.log' : `tasks/${event.cardId}/task.log`
          pendingEvents.set(
            event.id,
            file,
          )
        }
      }
    }

    const savedReports = pending.flatMap(note => {
      const file = pendingEvents.get(note.id)

      if (!file) {
        return []
      }

      return [
        {
          id: note.id,
          file,
          status: contextReportStatus({
            state,
            note,
          }),
        },
      ]
    })
    lines.push(`Pending reports: ${JSON.stringify(savedReports)}`)

    if (reviewOverflow) {
      lines.push(`Read the full titan.review record ${JSON.stringify(reviewId)} in titan.log.`)
    }
  }

  lines.push(decisionsText({
    state,
    now,
    pick,
  }))
  lines.push(QUIET_RULE)
  lines.push(REPLY_RULES)

  return `<othrys-wake>${lines.join('\n')}</othrys-wake>`
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

// The first turn after Titan could not start: the owner's messages no turn took, and how much more waits for the next wake.
// carried names the owner's messages the text lists, which Titan takes with it.
export function recapText({
  state,
  since,
  after,
  now,
  why,
}: {
  state: TitanState
  since: string
  after: number
  now: number
  // Why Titan was stopped; an outage when not given.
  why?: string
}): {
  text: string
  carried: string[]
} {
  const minutes = outageMinutes({
    since,
    now,
  })
  const sent = (state.titanMessages ?? []).filter(message =>
    (state.eventIds[message.id] ?? 0) > after)
  // A message whose turn started has been read; worker reports reach Titan in their own wake.
  const unread = sent.filter(message => !message.stopped && !message.failure
    && ownerActor({ actor: message.actor })
    && !titanInputDispatched({
      state,
      message,
    }))
  const unreadLines = unread.map(message => {
    const card = message.task ? state.cards[message.task] : undefined
    const task = card ? ` on ${taskMention({
      id: card.id,
      title: card.title,
    })}` : ''

    return `- ${message.at}${task}:\n${sealed({ text: message.text })}`
  })
  const reports = sent.filter(message => reportActor({ actor: message.actor })).length

  const text = `<othrys-wake>${[
    why ?? `Why you are woken: back after outage. Othrys could not start you from ${since} until now (${minutes} min).`,
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
  ].join('\n')}</othrys-wake>`

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
  state: TitanState
  pattern: RegExp
}): number {
  const observed = Object.values(state.sessions ?? {}).flatMap(session => [
    session.wakeStarted ?? '',
    session.wakeHandled ?? '',
  ])
  const covered = [
    ...Object.keys(state.eventIds),
    ...observed,
  ].flatMap(id => pattern.exec(id)?.[1] ?? [])
    .map(Number)

  return Math.max(
    0,
    ...covered,
  )
}

export function handledWakesThrough({ state }: { state: TitanState }): number {
  return Math.max(
    wakesThrough({
      state,
      pattern: WAKE_HANDLED,
    }),
    state.titanHandledSeq ?? 0,
  )
}

// A wake counts once the turn that read it finishes, so a failed turn's updates are offered again.
export function wakeCursor({
  state,
  fallback,
}: {
  state: TitanState
  fallback: number
}): number {
  const handled = handledWakesThrough({ state })

  if (handled > 0) {
    return handled
  }

  return fallback
}

export function findTitanTurnToResume({
  titanId,
  state,
  agent,
}: {
  titanId: string
  state: TitanState
  agent: AgentRef
}): {
  resumeAttemptId: string
  resumeMessage: string
  wakeThrough: number
} | undefined {
  const cached = state.sessions?.[sessionId({ agent })]?.titanTurn
  const legacyTurn = cached ? undefined : scanChanges({
    titanId,
    cardId: TITAN_CARD,
    types: [
      'titan.delivered',
      'titan.configured',
    ],
    descending: true,
  }).find(event => {
    if (event.cardId !== TITAN_CARD || !event.id.endsWith(':hosted')) {
      return false
    }

    return event.type === 'titan.delivered'
      ? event.data.session === sessionId({ agent })
      : event.type === 'titan.configured' && event.data.titan?.session === sessionId({ agent })
  })

  const cutTitanTurn = cached ?? legacyTurn
  const resumes = cached?.resumes ?? (legacyTurn ? resumesInARow({
    turn: legacyTurn,
    read: ({ seq }) => readChanges({
      titanId,
      seqs: [seq],
    })[0],
  }) : 0)

  if (!cutTitanTurn || resumes >= MAX_RESUMES) {
    return undefined
  }

  const resumeAttemptId = `resume:${cutTitanTurn.seq}`

  if (resumeAttemptId in state.eventIds) {
    return undefined
  }

  const finishedThrough = cached?.finishedThrough || undefined
  const lastFinishedTurn = finishedThrough ? undefined : scanChanges({
    titanId,
    cardId: TITAN_CARD,
    types: [
      'session.observed',
      'task.edited',
    ],
    before: cutTitanTurn.seq,
    descending: true,
  }).find(event => {
    const fields = sessionFields({ event })

    return fields?.activity === 'finished' && event.actor === 'othrys'
      && fields.agent?.sessionId === agent.sessionId && fields.agent.provider === agent.provider
      && fields.agent.agentId === agent.agentId
  })
  const sourceId = cutTitanTurn.id.replace(
    /:compact:hosted$|:hosted$/,
    '',
  )
  const source = readChanges({
    titanId,
    types: ['titan.message'],
    ids: [sourceId],
  })[0]
  const lastFinishedTurnSeq = Math.min(
    finishedThrough ?? lastFinishedTurn?.seq ?? 0,
    source ? source.seq - 1 : Infinity,
  )
  const unansweredMessages: string[] = []

  for (const event of scanChanges({
    titanId,
    types: ['titan.message'],
    after: lastFinishedTurnSeq,
  })) {
    if (event.type !== 'titan.message' || !ownerActor({ actor: event.actor })) {
      continue
    }

    unansweredMessages.push(event.id)
  }

  const wakeThroughSeq = WAKE_TURN.exec(cutTitanTurn.id)?.[1]
  const isStallCheck = /^(stall|wait|unconfirmed):/.test(cutTitanTurn.id)
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
  const ownerReads = unansweredMessages.map(id =>
    `Read owner message ${JSON.stringify(id)} in titan.log in full.`)

  return {
    resumeAttemptId,
    wakeThrough: Number(wakeThroughSeq ?? 0),
    resumeMessage: `<othrys-wake>An Othrys server restart cut your last turn before you answered ${interruptedWork}. ${recordContext({ titanId })} Answer what is still open and tell the owner in one line that the restart cut your reply.\n${[
      ...ownerReads,
      decisionsText({
        state,
        now: Date.now(),
      }),
    ].join('\n')}\n${REPLY_RULES}</othrys-wake>`,
  }
}
