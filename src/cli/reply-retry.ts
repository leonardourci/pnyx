import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { decideReply } from '../core/decide.ts'
import type { Card, ReplyState } from '../core/model.ts'
import type { HydraEvent, HydraState } from '../app/model.ts'
import { liveTask } from '../core/tasks.ts'
import { HOOK } from '../integrations/hooks/observe.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { transcriptMessages } from '../oracle/text.ts'
import { withWriter, type Writer } from '../app/writer.ts'
import { loadHydra } from '../app/store.ts'
import { readEvents } from '../app/event-log.ts'
import { threadPath } from '../thread/read.ts'

// A resend's reply id is the original's with this and its try number.
const RETRY_MARK = '~retry'
// Resends before Hydra is told the message never arrived.
export const MAX_RESENDS = 2
// A send gets this long to show up in the session before it counts as missing.
const RESEND_GRACE_MS = 60_000
// How far back from its end a transcript is read for the message.
const TRANSCRIPT_WINDOW = 4 * 1024 * 1024
// Only a reply sent this recently is followed up, so an old one is never resent out of the blue.
const FOLLOW_UP_WINDOW_MS = 30 * 60 * 1000
// A transcript stamps a message a little after Pnyx queued it, never long before.
const CLOCK_SLACK_MS = 1000
// How much of the message, whitespace folded, must appear in the transcript.
const MATCH_CHARS = 200

type ReplyFollowUp =
  | {
    kind: 'confirm'
    card: string
    reply: string
    route: string
  }
  | {
    kind: 'resend'
    card: string
    reply: string
    route: string
    text: string
    retry: string
  }
  | {
    kind: 'unconfirmed'
    card: string
    reply: string
    text: string
  }

// The first receipt carries the reply's text and route; the last says when it was last tried.
type Sent = {
  text?: string
  route: string
  control: boolean
  firstAt: number
  lastAt: number
}

const folded = ({ text }: { text: string }) => text.replace(
  /\s+/g,
  ' ',
).trim()

// Replies a route could not confirm, other than resends, answers to a request and setting changes.
const unconfirmedOriginals = ({ card }: { card: Card }) => (card.replies ?? [])
  .filter(reply => reply.state === 'delivery_unknown' && !reply.answers && !reply.id.includes(RETRY_MARK)
    && !card.steering?.some(message => message.reply === reply.id))

// Whether any reply could need a follow-up, so the server knows to keep checking.
// ponytail: gated on the card's last update, not the reply's age; record a send time on the reply if polling runs long.
export function repliesToFollow({
  state,
  now = Date.now(),
}: {
  state: HydraState
  now?: number
}): boolean {
  return Object.values(state.cards).some(card => {
    const recent = now - Date.parse(card.updatedAt) < FOLLOW_UP_WINDOW_MS

    return liveTask({ card }) && recent && unconfirmedOriginals({ card }).length > 0
  })
}

function sentReplies({ events }: { events: HydraEvent[] }): Map<string, Sent> {
  const sent = new Map<string, Sent>()

  for (const event of events) {
    if (event.type !== 'card.replied') {
      continue
    }

    const key = `${event.cardId}:${event.data.reply}`
    const known = sent.get(key)
    const at = Date.parse(event.at)

    if (known) {
      known.lastAt = at

      continue
    }

    sent.set(
      key,
      {
        text: event.data.text,
        route: event.data.route,
        control: event.data.control === true,
        firstAt: at,
        lastAt: at,
      },
    )
  }

  return sent
}

// Whether the session's transcript shows the message as a user turn after it was sent; a missing transcript shows nothing.
// ponytail: reads only the last TRANSCRIPT_WINDOW; record the transcript size at send time if huge turns push messages out.
function transcriptHas({
  path,
  text,
  after,
}: {
  path: string
  text: string
  after: number
}): boolean {
  const wanted = folded({ text }).slice(
    0,
    MATCH_CHARS,
  )
  let fd: number | undefined

  try {
    fd = openSync(
      path,
      'r',
    )
    const size = fstatSync(fd).size
    const start = Math.max(
      0,
      size - TRANSCRIPT_WINDOW,
    )
    const buffer = Buffer.alloc(size - start)
    readSync(
      fd,
      buffer,
      0,
      buffer.length,
      start,
    )
    const lines = buffer.toString('utf8').split('\n')

    return lines.some(line => {
      let record: unknown

      try {
        record = JSON.parse(line)
      } catch {
        return false
      }

      const fields = record as {
        type?: unknown
        payload?: { role?: unknown }
      }
      const fromUser = fields.type === 'user' || fields.payload?.role === 'user'

      if (!fromUser) {
        return false
      }

      return transcriptMessages({ record }).some(message => {
        const recordedAt = message.at ? Date.parse(message.at) : after
        const said = folded({ text: message.text })
        const whole = said === wanted || said.endsWith(wanted)
        // A short reply must end the message, or a word like "yes" would match any later one.
        const matches = wanted.length < MATCH_CHARS ? whole : said.includes(wanted)

        return recordedAt >= after && matches
      })
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

// What each unconfirmed reply needs now; pure apart from reading the log and transcripts.
// tried holds the resends sent so far by retry id and time, as one that failed before its receipt leaves no record.
function replyFollowUps({
  hydraId,
  state,
  tried,
  now,
}: {
  hydraId: string
  state: HydraState
  tried: Map<string, number>
  now: number
}): ReplyFollowUp[] {
  if (!repliesToFollow({
    state,
    now,
  })) {
    return []
  }

  const sent = sentReplies({ events: readEvents({ hydraId }) })
  const followUps: ReplyFollowUp[] = []

  for (const card of Object.values(state.cards)) {
    if (!liveTask({ card })) {
      continue
    }

    const replies = card.replies ?? []
    const activity = card.sessionActivity ?? card.activity
    const waiting = card.attention.some(a => a.blocking && !a.answered && a.key.startsWith(HOOK))
    const path = threadPath({ card })

    // Only an idle session with a transcript can show whether a message arrived.
    if (activity === 'working' || waiting || !path) {
      continue
    }

    for (const reply of unconfirmedOriginals({ card })) {
      const original = sent.get(`${card.id}:${reply.id}`)

      if (!original?.text) {
        continue
      }

      const outsideRoute = original.control || original.route.startsWith('firstmate')
      const tooOld = now - original.firstAt >= FOLLOW_UP_WINDOW_MS

      if (outsideRoute || tooOld) {
        continue
      }

      const retryPrefix = `${reply.id}${RETRY_MARK}`
      const retries = replies.filter(retry => retry.id.startsWith(retryPrefix))
      const triedIds = [...tried.keys()].filter(id => id.startsWith(retryPrefix))
      const retryIds = new Set([
        ...retries.map(retry => retry.id),
        ...triedIds,
      ])
      const inFlight = retries.some(retry => retry.state === 'queued' || retry.state === 'delivered')
      const lastAt = Math.max(
        original.lastAt,
        ...retries.map(retry => sent.get(`${card.id}:${retry.id}`)?.lastAt ?? 0),
        ...triedIds.map(id => tried.get(id) ?? 0),
      )

      if (inFlight || now - lastAt < RESEND_GRACE_MS) {
        continue
      }

      const text = original.text

      if (transcriptHas({
        path,
        text,
        after: original.firstAt - CLOCK_SLACK_MS,
      })) {
        followUps.push({
          kind: 'confirm',
          card: card.id,
          reply: reply.id,
          route: original.route,
        })
      } else if (retryIds.size < MAX_RESENDS) {
        followUps.push({
          kind: 'resend',
          card: card.id,
          reply: reply.id,
          route: original.route,
          text,
          retry: `${retryPrefix}${retryIds.size + 1}`,
        })
      } else {
        followUps.push({
          kind: 'unconfirmed',
          card: card.id,
          reply: reply.id,
          text,
        })
      }
    }
  }

  return followUps
}

function recordArrived({
  writer,
  card,
  reply,
  route,
  detail,
}: {
  writer: Writer
  card: string
  reply: string
  route: string
  detail: string
}) {
  const decision = decideReply({
    state: writer.state,
    ref: card,
    data: {
      reply,
      route,
      state: 'delivered',
      detail,
    },
    meta: {
      at: new Date().toISOString(),
      actor: 'pnyx',
    },
  })

  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}

// Confirms, resends, or hands to unconfirmed each reply its route could not confirm.
export async function followUpReplies({
  hydraId,
  tried,
  resend,
  unconfirmed,
  now = Date.now(),
}: {
  hydraId: string
  tried: Map<string, number>
  resend({
    card,
    text,
    retry,
  }: {
    card: string
    text: string
    retry: string
  }): Promise<ReplyState>
  unconfirmed({
    card,
    reply,
    text,
  }: {
    card: string
    reply: string
    text: string
  }): void
  now?: number
}): Promise<void> {
  const followUps = replyFollowUps({
    hydraId,
    state: loadHydra({ hydraId }).state,
    tried,
    now,
  })

  for (const followUp of followUps) {
    if (followUp.kind === 'confirm') {
      withWriter({
        hydraId,
        fn: ({ writer }) => {
          drainSpool({ writer })
          recordArrived({
            writer,
            card: followUp.card,
            reply: followUp.reply,
            route: followUp.route,
            detail: 'found in the session transcript',
          })
        },
      })
    } else if (followUp.kind === 'unconfirmed') {
      unconfirmed({
        card: followUp.card,
        reply: followUp.reply,
        text: followUp.text,
      })
    } else {
      tried.set(
        followUp.retry,
        now,
      )
      const state = await resend({
        card: followUp.card,
        text: followUp.text,
        retry: followUp.retry,
      })

      if (state === 'delivered') {
        withWriter({
          hydraId,
          fn: ({ writer }) => recordArrived({
            writer,
            card: followUp.card,
            reply: followUp.reply,
            route: followUp.route,
            detail: `resent as ${followUp.retry}`,
          }),
        })
      }
    }
  }
}
