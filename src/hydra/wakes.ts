import type { HydraState } from '#app/model.ts'
import { decisionsBlock } from '#tasks/decisions.ts'
import { QUIET_REPLY, hydraDelivery, reportActor } from './hydra.ts'
import type { HydraMessage } from './model.ts'
import { ownerActor, HYDRA_ACTOR } from '#app/actors.ts'
import { taskMention } from './mentions.ts'
import { clip } from './digest.ts'
import type { AgentRef } from '#workers/model.ts'
import { readEvents } from '#app/event-log.ts'
import { HYDRA_CARD } from './identity.ts'
import { sessionId } from '#workers/session-attachments.ts'

// One change Hydra has not read yet: its event and the card it is about.
export interface QueuedUpdate {
  seq: number
  card: string
  kind?: string
}

export interface HydraQueue {
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

// Every change wake ends on this, so Hydra never mistakes a result for nothing to say.
const QUIET_RULE = `If none of this needs the owner, reply only ${QUIET_REPLY}. A result (ready for review, merged, findings, or a failure or blocker you cannot clear, including a failed retry the owner must act on) always gets a reply.`

// One check turn: why Hydra is woken, the reports that arrived since the last one, each in its own envelope, and the check that lists every other change.
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

  if (reasons.length) {
    lines.push(
      'Why you are woken:',
      ...reasons.map(line => sealed({ text: line })),
    )
  }

  if (reports.length) {
    const count = reports.length === 1 ? 'A worker report' : `${reports.length} worker reports`
    lines.push(`${count} arrived while you were busy. Handle them together and answer once.`)

    for (const message of reports) {
      lines.push(sealed({ text: hydraDelivery({ message }) }))
    }
  }

  if (check) {
    lines.push(`Run \`pnyx-axi hydra check --after ${after} --hydra ${hydraId}\` for the details and every other change, and handle what it lists.`)
  }

  if (review) {
    lines.push(sealed({ text: review }))
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
export function recapText({
  state,
  since,
  after,
  now,
}: {
  state: HydraState
  since: string
  after: number
  now: number
}): string {
  const minutes = outageMinutes({
    since,
    now,
  })
  const sent = (state.hydraMessages ?? []).filter(message =>
    (state.eventIds[message.id] ?? 0) > after)
  // A message whose turn started has been read; worker reports reach Hydra in their own wake.
  const unread = sent.filter(message => ownerActor({ actor: message.actor })
    && !(`${message.id}:hosted` in state.eventIds))
    .map(message => {
      const card = message.task ? state.cards[message.task] : undefined
      const task = card ? ` on ${taskMention({
        id: card.id,
        title: card.title,
      })}` : ''

      return `- ${message.at}${task}: ${clip({
        text: message.text,
        size: 300,
      })}`
    })
  const reports = sent.filter(message => reportActor({ actor: message.actor }) && message.kind !== 'progress').length

  return `<pnyx-wake>${[
    `Why you are woken: back after outage. Pnyx could not start you from ${since} until now (${minutes} min).`,
    ...unread.length ? [
      'The owner wrote to you meanwhile and has had no reply; answer these:',
      ...unread,
    ] : ['The owner sent you nothing meanwhile.'],
    ...reports ? [`${reports === 1 ? 'A worker report' : `${reports} worker reports`} and any other changes from the outage reach you in your next wake.`] : [],
    decisionsText({
      state,
      now,
    }),
    `If none of this needs the owner, reply only ${QUIET_REPLY}.`,
    REPLY_RULES,
  ].join('\n')}</pnyx-wake>`
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
  const events = readEvents({ hydraId })
  const cutHydraTurn = events.findLast(event => {
    if (event.type !== 'board.configured' || event.cardId !== HYDRA_CARD) {
      return false
    }

    const matchesSession = event.data.hydra?.session === sessionId({ agent })
    const isHostedTurn = event.id.endsWith(':hosted')

    return matchesSession && isHostedTurn
  })

  if (!cutHydraTurn || cutHydraTurn.id.startsWith('resume:')) {
    return undefined
  }

  const resumeAttemptId = `resume:${cutHydraTurn.seq}`

  if (resumeAttemptId in state.eventIds) {
    return undefined
  }

  const lastFinishedTurn = events.findLast(event => {
    if (event.type !== 'card.pushed') {
      return false
    }

    const finishedBeforeCut = event.seq < cutHydraTurn.seq && event.data.activity === 'finished'
    const recordedByServer = event.actor === 'pnyx'
    const matchesSession = event.data.agent?.sessionId === agent.sessionId
      && event.data.agent.provider === agent.provider

    return finishedBeforeCut && recordedByServer && matchesSession
  })
  const sourceId = cutHydraTurn.id.replace(
    /:compact:hosted$|:hosted$/,
    '',
  )
  const source = events.find(event => event.type === 'hydra.message' && event.id === sourceId)
  const lastFinishedTurnSeq = Math.min(
    lastFinishedTurn?.seq ?? 0,
    source ? source.seq - 1 : Infinity,
  )
  const unansweredMessageSeqs = events.filter(event => {
    const isNewMessage = event.seq > lastFinishedTurnSeq && event.type === 'hydra.message'
    const sentToHydra = event.actor !== HYDRA_ACTOR
    const progress = event.type === 'hydra.message' && event.data.kind === 'progress'

    return isNewMessage && sentToHydra && !progress
  }).map(event => event.seq)
  const wakeThroughSeq = WAKE_TURN.exec(cutHydraTurn.id)?.[1]
  const isStallCheck = /^(stall|wait|unconfirmed):/.test(cutHydraTurn.id)
  const unfinishedWork: string[] = []

  if (unansweredMessageSeqs.length) {
    const firstMessageSeq = unansweredMessageSeqs[0]
    const lastMessageSeq = unansweredMessageSeqs.at(-1)
    let unansweredMessagesPhrase = `messages seq ${firstMessageSeq}`

    if (unansweredMessageSeqs.length > 1) {
      unansweredMessagesPhrase = `messages seq ${firstMessageSeq} to ${lastMessageSeq}`
    }

    unfinishedWork.push(unansweredMessagesPhrase)
  }

  if (wakeThroughSeq) {
    const wakeCheckPhrase = `a wake check through seq ${wakeThroughSeq}`
    unfinishedWork.push(wakeCheckPhrase)
  }

  if (isStallCheck) {
    const stallCheckPhrase = 'a stall check'
    unfinishedWork.push(stallCheckPhrase)
  }

  const cutTurnHasNoRecordedWork = unansweredMessageSeqs.length === 0
    && wakeThroughSeq === undefined && !isStallCheck
  const unrecordedCutTurnPhrase = 'a turn'
  let interruptedWork: string

  if (cutTurnHasNoRecordedWork) {
    interruptedWork = unrecordedCutTurnPhrase
  } else {
    interruptedWork = unfinishedWork.join(' and ')
  }

  return {
    resumeAttemptId,
    wakeThrough: Number(wakeThroughSeq ?? 0),
    resumeMessage: `<pnyx-wake>A Pnyx server restart cut your last turn before you answered ${interruptedWork}. Run \`pnyx-axi hydra messages --after ${lastFinishedTurnSeq} --hydra ${hydraId}\` and \`pnyx-axi hydra check --after ${lastFinishedTurnSeq} --hydra ${hydraId}\`, then answer what is still open; tell the owner in one line that the restart cut your reply.\n${REPLY_RULES}</pnyx-wake>`,
  }
}
