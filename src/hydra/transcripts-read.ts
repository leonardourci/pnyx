import { THREAD_PAGE_LIMIT } from './thread-history.ts'
import { log } from '#app/diagnostics.ts'
import { messageReference } from './message-reference.ts'
import { HYDRA_CARD } from './identity.ts'
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentRef, ReplyState } from '#workers/model.ts'
import { hydraDir } from '#app/home-migration.ts'
import { readEventsFrom } from '#app/event-log.ts'
import { redact } from '#oracle/text.ts'
import { readTranscriptRecord } from '#workers/transcripts.ts'
import { readTranscript } from '#workers/transcript-read.ts'
import type { TranscriptRecord } from '#workers/provider.ts'
import { HOST_LABEL, replyRoute, type ReplyRoute } from '#workers/reply-route.ts'
import { traces } from '#preferences/view.ts'
import { taskReceipt } from './transcripts-task.ts'
import { cardSessionId } from '#workers/session-attachments.ts'
import { movedHistory } from '#tasks/move-history.ts'
import { shortened, type ActionRead } from './calls.ts'
import { readAction } from './transcript-calls.ts'
import { effectiveView } from '#settings/store.ts'
import { isManagedTask } from '#tasks/select.ts'
import type { TurnActions } from './conversation.ts'
import type { TurnTiming } from './chat-messages.ts'
import { threadEntryOrder } from './thread-order.ts'

// messageId and part let the Hydra rejoin a long message split into transport chunks.
export interface ThreadEntry {
  final?: boolean
  block?: number
  reference?: string
  id: string
  hidden?: boolean
  continued?: boolean
  role: string
  // divider: a conversation milestone drawn as a line across the chat.
  kind: 'message' | 'tool' | 'thinking' | 'divider'
  text: string
  at?: string
  session?: string
  streaming?: boolean
  receipt?: ReplyState
  // When the owner sent it; the transcript's at is when the agent read it.
  sent?: string
  // When the agent's harness confirmed it took this message.
  received?: string
  // Why a queued message still waits, when Pnyx knows.
  waiting?: string
  delivery?: {
    agent?: {
      state: ReplyState
      detail?: string
      received?: string
    }
    hydra: {
      state: ReplyState
      detail?: string
      received?: string
    }
  }
  task?: string
  // The owner's message answers or discusses this question on its task, choosing this option.
  answers?: string
  discusses?: string
  choice?: string
  // Pairs a tool call with its result.
  call?: string
  initial?: boolean
  replyId?: string
  messageId?: string
  part?: number
}
export interface ThreadPage {
  card: string
  session?: string
  stream?: string
  version?: number
  pages?: number
  recent?: boolean
  entries: ThreadEntry[]
  conversation?: {
    through: number
    entries: ThreadEntry[]
    folds: Record<string, TurnActions>
    timings: Record<string, TurnTiming>
    trailing: Record<string, ThreadEntry[]>
  }
  unavailable?: string
  currentTurn?: {
    at: string
    owner: boolean
  }
  actions?: HydraEvent[]
  older?: string
  route: boolean
  via?: string
  routeKind?: ReplyRoute['kind']
  noRoute?: string
  watching: 'unknown'
}
const MAX_BYTES = 10 * 1024 * 1024
// Parts bound each transport entry without cutting a logical message at a page boundary.
const MAX_TEXT = 1000

export const replyEntryId = ({ reply }: { reply: string }) => `reply:${reply}`

export const splitEntry = ({ entry }: { entry: ThreadEntry }): ThreadEntry[] => {
  const fromPart = (entry.part ?? 0) > 0
  const continued = entry.continued === true || fromPart || entry.role.endsWith(' · continued')
  // Transport parts were redacted before their offsets were assigned.
  const text = entry.messageId ? entry.text : redact({ text: entry.text })

  if (text.length <= MAX_TEXT) {
    return [
      {
        ...entry,
        role: entry.role.replace(
          / · continued$/,
          '',
        ),
        continued,
        text,
      },
    ]
  }

  const parts: ThreadEntry[] = []

  for (let start = 0; start < text.length;) {
    let end = Math.min(
      start + MAX_TEXT,
      text.length,
    )
    const last = text.charCodeAt(end - 1)

    if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
      end--
    }

    parts.push({
      ...entry,
      id: `${entry.id}.${start}`,
      messageId: entry.id,
      part: start,
      text: text.slice(
        start,
        end,
      ),
      role: entry.role.replace(
        / · continued$/,
        '',
      ),
      continued: start > 0 || continued,
    })
    start = end
  }

  return parts
}

interface EntryOptions {
  offset: number
  tools?: boolean
  thinking?: boolean
  boundaries?: boolean
}

export function recordEntries({
  record,
  ...options
}: EntryOptions & { record: unknown }): ThreadEntry[] {
  return transcriptEntries({
    parsed: readTranscriptRecord({ record }),
    ...options,
  })
}

export function transcriptEntries({
  parsed,
  offset,
  tools = true,
  thinking = true,
  boundaries = false,
}: EntryOptions & { parsed: TranscriptRecord }): ThreadEntry[] {
  const messages = parsed.messages.filter(message => boundaries || !message.internal)
  const entries: ThreadEntry[] = messages.map((
    message,
    index,
  ) => ({
    id: `${offset}:m${index}`,
    kind: 'message',
    role: parsed.role,
    text: message.text,
    at: message.at,
    hidden: message.internal,
    final: parsed.final,
    block: message.block,
  }))

  for (const trace of parsed.traces) {
    if ((trace.kind === 'tool' && !tools) || (trace.kind === 'thinking' && !thinking)) {
      continue
    }

    const entry: ThreadEntry = {
      id: `${offset}:t${trace.index}`,
      block: trace.index,
      kind: trace.kind,
      role: trace.role,
      at: parsed.at,
      text: trace.text,
    }

    if (trace.call !== undefined) {
      entry.call = trace.call
    }

    entries.push(entry)
  }

  return entries.sort((
    a,
    b,
  ) => (a.block ?? 0) - (b.block ?? 0)).flatMap(entry => splitEntry({ entry }))
}

export function threadPath({ card }: { card: Pick<Card, 'agent'> }): string | undefined {
  const path = card.agent?.transcriptPath

  return path && isAbsolute(path) && path.endsWith('.jsonl') && [
    'claude',
    'claude-code',
    'codex',
  ].includes(card.agent!.provider) ? path : undefined
}

export type SessionEntry = ThreadEntry & {
  reference: string
  session: string
}

// One session's whole native transcript, each entry with the reference its thread page gives it.
export function sessionEntries({
  path,
  session,
  boundaries,
}: {
  path: string
  session: string
  boundaries: boolean
}): SessionEntry[] {
  const lines = readTranscript({
    cursor: {
      source: path,
      identity: '',
      pos: 0,
    },
  })?.lines ?? []

  return lines.flatMap(line => recordEntries({
    record: line.record,
    offset: line.pos,
    boundaries,
  }).map(item => ({
    ...item,
    reference: messageReference({
      session,
      id: item.id,
      messageId: item.messageId,
    }),
    session,
  })))
}

export interface HydraSession {
  session: string
  agent: AgentRef
}

// Every session Hydra has been configured with, oldest first; the card holds the current
// session's latest agent.
export function hydraSessions({ state }: { state: HydraState }): HydraSession[] {
  const hydra = state.cards[HYDRA_CARD]
  const current = hydra && cardSessionId({ card: hydra })
  const ids = [...state.hydraSessions ?? []]

  if (current && !ids.includes(current)) {
    ids.push(current)
  }

  return ids.flatMap(session => {
    const agent = session === current ? hydra!.agent : state.sessions?.[session]?.agent

    return agent && !agent.agentId ? [
      {
        session,
        agent,
      },
    ] : []
  })
}

// The messages of every session Hydra has had, read from their native transcripts. A
// transcript last written before after holds nothing later, so it is skipped.
export function hydraEntries({
  state,
  after,
}: {
  state: HydraState
  after?: string
}): SessionEntry[] {
  const written = ({ path }: { path: string }) => after === undefined
    || (statSync(
      path,
      { throwIfNoEntry: false },
    )?.mtimeMs ?? 0) >= Date.parse(after)

  return hydraSessions({ state }).flatMap(({
    session,
    agent,
  }) => {
    const path = threadPath({ card: { agent } })

    return path && written({ path }) ? sessionEntries({
      path,
      session,
      boundaries: true,
    }) : []
  })
}

export interface LatestMessage {
  role: 'user' | 'assistant'
  text: string
  at?: string
}
const LATEST_TEXT = 280
const LATEST_WINDOW = 64 * 1024

// Only agent-authored text can become a card update.
function lastMessage({ lines }: { lines: string[] }): LatestMessage | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: unknown

    try {
      record = JSON.parse(lines[i]!)
    } catch {
      continue
    }

    const parsed = readTranscriptRecord({ record })
    const messages = parsed.messages.filter(message => !message.internal)

    if (!messages.length || parsed.role !== 'assistant') {
      continue
    }

    const text = redact({ text: messages.map(m => m.text).join(' ') }).replace(
      /\s+/g,
      ' ',
    )
      .trim()

    return {
      role: 'assistant',
      text: shortened({
        text,
        max: LATEST_TEXT,
      }),
      ...(messages[0]!.at ? { at: messages[0]!.at } : {}),
    }
  }

  return null
}

// A transcript's last message and how far it was read: size is the end of its last
// complete line, so a later read of the same file parses only what was appended.
export interface LatestRead extends ActionRead {
  message: LatestMessage | null
  path: string
  ino: number
  size: number
}

// Given the previous read of the same, grown file, parses only the complete lines
// appended since and keeps the previous message when they hold none. Otherwise reads
// back from the end: a window of tool output doubles until a message turns up or
// MAX_BYTES is read. message is null when the file holds no message or is unreadable.
export function latestMessage({
  path,
  prev,
}: {
  path: string
  prev?: LatestRead
}): LatestRead {
  let fd: number | undefined

  try {
    fd = openSync(
      path,
      'r',
    )
    const {
      size,
      ino,
    } = fstatSync(fd)

    // Complete lines from start: the last may still be written.
    const read = ({ start }: { start: number }) => {
      const buf = Buffer.alloc(size - start)
      readSync(
        fd!,
        buf,
        0,
        buf.length,
        start,
      )
      const end = buf.lastIndexOf(10) + 1

      return {
        lines: buf.toString(
          'utf8',
          0,
          end,
        ).split('\n')
          .slice(
            0,
            -1,
          ),
        size: start + end,
      }
    }

    const grown = prev?.path === path && prev.ino === ino && prev.size <= size

    if (prev && grown && size - prev.size <= MAX_BYTES) {
      const {
        lines,
        size: end,
      } = read({ start: prev.size })

      return {
        message: lastMessage({ lines }) ?? prev.message,
        ...readAction({
          lines,
          prev,
        }),
        path,
        ino,
        size: end,
      }
    }

    for (let window = LATEST_WINDOW; ; window *= 2) {
      const start = Math.max(
        0,
        size - Math.min(
          window,
          MAX_BYTES,
        ),
      )
      const {
        lines,
        size: end,
      } = read({ start })
      // The first line may be cut by the window.
      const whole = lines.slice(start ? 1 : 0)
      const message = lastMessage({ lines: whole })

      if (message || !start || window >= MAX_BYTES) {
        return {
          message,
          ...readAction({ lines: whole }),
          path,
          ino,
          size: end,
        }
      }
    }
  } catch {
    return {
      message: null,
      action: null,
      answered: [],
      open: false,
      path,
      ino: 0,
      size: 0,
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

// A cursor carries each sources position, so paging cannot skip transcript
// chunks when reply receipts also fill the latest page.
export const THREAD_CURSOR = /^n(?:(\d+)\.)?(\d+:\d+)?;r(\d+:\d+)?$/
type LoggedMessage = HydraEvent
const replyLogs = new Map<string, {
  end: number
  events: LoggedMessage[]
}>()

function repliedEvents({ hydraId }: { hydraId: string }): LoggedMessage[] {
  const dir = hydraDir({ hydraId })
  let log = replyLogs.get(dir) ?? {
    end: 0,
    events: [],
  }
  let read = readEventsFrom({
    hydraId,
    offset: log.end,
  })

  if (!read) {
    log = {
      end: 0,
      events: [],
    }; read = readEventsFrom({
      hydraId,
      offset: 0,
    })
  }

  const added = (read?.events ?? []).filter((e): e is LoggedMessage =>
    (e.type === 'card.replied' && !!e.data.text)
    || (e.actor === 'hydra' && e.type !== 'hydra.message'))
  log = {
    end: read?.end ?? 0,
    events: added.length ? [
      ...log.events,
      ...added,
    ] : log.events,
  }
  replyLogs.set(
    dir,
    log,
  )

  return log.events
}

// A moved task's owner replies stay in each Hydra it passed through. They are numbered in
// order across those Hydras, so the reply cursor stays one increasing number; a task that
// never moved keeps its seqs.
function threadEvents({
  hydraId,
  card,
}: {
  hydraId: string
  card: Card
}): LoggedMessage[] {
  const history = movedHistory({
    hydraId,
    task: card.id,
    matches: ({ event }) => event.type === 'card.replied' && Boolean(event.data.text)
      && event.cardId === card.id,
  })

  if (!history.some(entry => entry.hydra !== hydraId)) {
    return repliedEvents({ hydraId })
  }

  return history.reverse().map((
    { event },
    index,
  ) => ({
    ...event,
    seq: index + 1,
  }))
}

export function threadAction({
  event,
  state,
}: {
  event: HydraEvent
  state: HydraState
}): boolean {
  const task = state.cards[event.cardId]

  return event.actor === 'hydra' && event.type !== 'hydra.message'
    && task !== undefined && !isManagedTask({ card: task })
}

type Candidate = {
  item: ThreadEntry
  native?: string
  reply?: string
}

// A transcript a thread pages through, newest first. index names an earlier Hydra session in
// the cursor; a task, or a session the reader chose, has one source without one.
type ThreadSource = {
  session?: string
  path?: string
  index?: number
}

function threadSources({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): ThreadSource[] {
  const session = cardSessionId({ card })
  const hydra = state.cards[HYDRA_CARD]
  const current = card.id === HYDRA_CARD && session !== undefined
    && session === (hydra && cardSessionId({ card: hydra }))

  if (!current) {
    return [
      {
        session,
        path: threadPath({ card }),
      },
    ]
  }

  const earlier = hydraSessions({ state }).filter(item => item.session !== session)

  return [
    {
      session,
      path: threadPath({ card }),
    },
    ...earlier.map(item => ({
      session: item.session,
      path: threadPath({ card: { agent: item.agent } }),
      index: state.hydraSessions!.indexOf(item.session),
    })).reverse(),
  ]
}

// The entries of one transcript before cursor, read back from its end in doubling windows
// until wanted entries turn up, the file starts or MAX_BYTES is read. start is where the read
// stopped, 0 at the start of the file.
function readNative({
  path,
  session,
  cursor,
  wanted,
  tools,
  thinking,
  boundaries,
  excludedAt,
  renamed,
}: {
  path: string
  session?: string
  cursor?: string
  wanted: number
  tools: boolean
  thinking: boolean
  boundaries: boolean
  excludedAt: string[]
  renamed: boolean
}): {
  found: Candidate[]
  start: number
} {
  let fd: number | undefined

  try {
    fd = openSync(
      path,
      'r',
    )
    const stat = fstatSync(fd)

    if (!stat.isFile()) {
      throw new Error('not a regular file')
    }

    const [
      offsetText,
      itemText,
    ] = (cursor ?? `${stat.size}`).split(':')
    const beforeOffset = Number(offsetText)
    const beforeItem = itemText === undefined ? undefined : Number(itemText)
    let end = Math.min(
      beforeOffset,
      stat.size,
    )

    // Include the record containing a chunk cursor, then exclude chunks at or
    // after that ordinal below. A single read stays within the 10 MB window.
    if (beforeItem !== undefined) {
      const tail = Buffer.alloc(Math.min(
        MAX_BYTES,
        stat.size - end,
      ))
      readSync(
        fd,
        tail,
        0,
        tail.length,
        end,
      )
      const newline = tail.indexOf(10)
      end += newline < 0 ? tail.length : newline + 1
    }

    let start = end, parsed = end
    let found: Candidate[] = []

    // Each doubling parses only the bytes before the lines already parsed.
    for (let size = 64 * 1024; ; size *= 2) {
      start = Math.max(
        0,
        end - Math.min(
          size,
          MAX_BYTES,
        ),
      )
      const buf = Buffer.alloc(parsed - start)
      readSync(
        fd,
        buf,
        0,
        buf.length,
        start,
      )
      const first = start ? buf.indexOf(10) + 1 : 0
      const window: Candidate[] = []
      let position = first

      while (position >= 0 && position < buf.length) {
        const newline = buf.indexOf(
          10,
          position,
        )

        if (newline < 0) {
          break
        }

        try {
          const offset = start + position
          const record = JSON.parse(buf.subarray(
            position,
            newline,
          ).toString())

          const decoded = readTranscriptRecord({ record })

          if (beforeItem !== undefined && offset === beforeOffset && decoded.at !== undefined) {
            excludedAt.push(decoded.at)
          }

          // Hidden traces must not use up the conversation page.
          transcriptEntries({
            parsed: decoded,
            offset,
            tools,
            thinking,
            boundaries,
          }).forEach((
            item,
            index,
          ) => {
            if (
              beforeItem === undefined
              || offset < beforeOffset
              || (offset === beforeOffset && index < beforeItem)
            ) {
              window.push({
                native: `${offset}:${index}`,
                item: {
                  ...item,
                  ...(renamed && session ? {
                    id: `${session}:${item.id}`,
                    ...(item.messageId ? { messageId: `${session}:${item.messageId}` } : {}),
                  } : {}),
                  reference: session ? messageReference({
                    session,
                    id: item.id,
                    messageId: item.messageId,
                  }) : undefined,
                  ...(session ? { session } : {}),
                },
              })
            }
          })
        } catch { /* Unsupported or incomplete records are not messages. */ }

        position = newline + 1
      }

      found = window.concat(found)

      if (first || !start) {
        parsed = start + first
      }

      if (!start || found.length >= wanted || size >= MAX_BYTES) {
        break
      }
    }

    return {
      found,
      start,
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

type ThreadRead = {
  hydraId: string
  state: HydraState
  card: Card
  homes: string[]
  before?: string
}

// A conversation page from the task's transcript and saved events, with a log line for how long the read took.
export function readThread({
  hydraId,
  state,
  card,
  homes,
  before,
}: ThreadRead): ThreadPage {
  const started = performance.now()
  const page = readThreadPage({
    hydraId,
    state,
    card,
    homes,
    before,
  })
  log({
    operation: 'history.read',
    name: before === undefined ? 'latest' : 'older',
    hydraId,
    taskId: card.id,
    count: page.entries.length,
    ms: performance.now() - started,
  })

  return page
}

function readThreadPage(
  {
    hydraId,
    state,
    card,
    homes,
    before,
  }: ThreadRead,
): ThreadPage {
  const found = replyRoute({
    card,
    homes,
  })
  const session = cardSessionId({ card })
  const result: ThreadPage = {
    card: card.id,
    ...(session ? { session } : {}),
    entries: [],
    route: 'route' in found,
    ...('route' in found ? {
      via: HOST_LABEL[found.route.kind],
      routeKind: found.route.kind,
    } : { noRoute: found.reason }),
    watching: 'unknown',
  }
  const match = before === undefined ? null : THREAD_CURSOR.exec(before)
  const sourceCursor = match?.[1] === undefined ? undefined : Number(match[1])
  const nativeCursor = match?.[2], replyCursor = match?.[3]
  const excludedAt: string[] = []
  let candidates: Candidate[] = []
  let earlierNative = false, emptyNativeCursor: string | undefined
  const selected = traces({
    view: effectiveView({ state }),
    card: card.id,
  })
  const tools = card.id === HYDRA_CARD || selected.tools
  const thinking = selected.thinking
  const sources = threadSources({
    state,
    card,
  })
  const named = sources.findIndex(source => source.index === sourceCursor)
  // A cursor naming a session this thread no longer pages reads no transcript.
  const first = sourceCursor === undefined ? 0 : named < 0 ? sources.length : named

  for (let position = first; position < sources.length; position++) {
    const source = sources[position]!
    const current = position === 0
    const label = source.index === undefined ? '' : `${source.index}.`

    if (!source.path) {
      if (current) {
        result.unavailable = 'No supported transcript is recorded for this session.'
      }

      continue
    }

    let read: ReturnType<typeof readNative>

    try {
      read = readNative({
        path: source.path,
        session: source.session,
        cursor: position === first ? nativeCursor : undefined,
        wanted: THREAD_PAGE_LIMIT - candidates.length,
        tools,
        thinking,
        boundaries: card.id === HYDRA_CARD,
        excludedAt,
        // Offsets repeat across transcripts, so an earlier session's entries carry its id.
        renamed: !current,
      })
    } catch {
      if (current) {
        result.unavailable = 'The recorded transcript is unavailable.'
      }

      continue
    }

    candidates = [
      ...read.found.map(candidate => ({
        ...candidate,
        native: `${label}${candidate.native}`,
      })),
      ...candidates,
    ]

    if (read.start > 0) {
      earlierNative = true

      if (!candidates.length) {
        emptyNativeCursor = `${label}${read.start}:0`
      }

      break
    }

    if (candidates.length >= THREAD_PAGE_LIMIT) {
      earlierNative = position + 1 < sources.length

      break
    }
  }

  const [
    replySeq,
    replyPart,
  ] = replyCursor?.split(':').map(Number) ?? [
    Infinity,
    Infinity,
  ]
  const seenReplies = new Set<string>()
  // A moved task's events are renumbered across the Hydras it passed through, so the cursor's boundary is looked up in the same list.
  const logged = threadEvents({
    hydraId,
    card,
  })
  const replyBoundary = logged.find(event => event.seq === replySeq)

  const beforeReply = ({
    event,
    index,
  }: {
    event: HydraEvent
    index: number
  }) => {
    if (!replyBoundary) {
      return event.seq < replySeq!
    }

    const time = event.at.localeCompare(replyBoundary.at)

    return time < 0 || time === 0 && (event.seq < replySeq!
      || event.seq === replySeq && index < replyPart!)
  }

  for (const e of logged) {
    if (e.seq === replySeq) {
      excludedAt.push(e.at)
    }

    if (e.type !== 'card.replied') {
      continue
    }

    if (e.cardId !== card.id || seenReplies.has(e.data.reply)) {
      continue
    }

    seenReplies.add(e.data.reply)
    const receipt = taskReceipt({
      card: state.cards[card.id] ?? card,
      reply: e.data.reply,
      hydraReceived: state.hydraMessages?.find(message => message.id === `task-context:${card.id}:${e.data.reply}`)?.received,
    })
    splitEntry({
      entry: {
        id: replyEntryId({ reply: e.data.reply }),
        reference: replyEntryId({ reply: e.data.reply }),
        replyId: e.data.reply,
        role: 'You',
        kind: 'message',
        text: e.data.text!,
        at: e.at,
        ...(e.sessionId ? { session: e.sessionId } : {}),
        receipt: 'queued',
        ...receipt,
        ...(e.data.reply.startsWith('brief:') ? { initial: true } : {}),
      },
    }).forEach((
      item,
      index,
    ) => {
      if (beforeReply({
        event: e,
        index,
      })) {
        candidates.push({
          item,
          reply: `${e.seq}:${index}`,
        })
      }
    })
  }

  const positions = new Map(candidates.map((
    candidate,
    index,
  ) => [
    candidate,
    index,
  ]))
  const native = candidates.filter(candidate => candidate.native)
  const replies = candidates.filter(candidate => candidate.reply).sort((
    a,
    b,
  ) => threadEntryOrder({
    first: a.item,
    second: b.item,
  }))
  const page: typeof candidates = []

  const incomplete = () => {
    const firstPart = page.at(-1)?.item.part

    return firstPart !== undefined && firstPart > 0
  }

  // Consume a contiguous suffix from each source even when a record was timestamped earlier.
  // A boundary message stays whole even when it exceeds the page target.
  while ((page.length < THREAD_PAGE_LIMIT || incomplete()) && (native.length || replies.length)) {
    const nativeLast = native.at(-1)
    const replyLast = replies.at(-1)
    const takeNative = nativeLast && (!replyLast || (nativeLast.item.at ?? '') >= (replyLast.item.at ?? ''))
    const selected = takeNative ? native.pop() : replies.pop()

    if (selected) {
      page.push(selected)
    }
  }

  const firstNative = page.findLast(candidate => candidate.native)?.native
  const firstReply = page.findLast(candidate => candidate.reply)?.reply
  page.sort((
    a,
    b,
  ) => threadEntryOrder({
    first: a.item,
    second: b.item,
  })
    || positions.get(a)! - positions.get(b)!)
  result.entries = page.map(e => e.item)

  if (card.id === HYDRA_CARD) {
    const firstAt = result.entries[0]?.at
    const beforeAt = excludedAt.toSorted()[0]
    result.actions = repliedEvents({ hydraId }).filter(event => {
      const afterStart = firstAt !== undefined && event.at >= firstAt
      const beforeEnd = beforeAt === undefined || event.at <= beforeAt
      const inPage = afterStart && beforeEnd

      return inPage && threadAction({
        event,
        state,
      })
    })
  }

  const carried = `${sourceCursor === undefined ? '' : `${sourceCursor}.`}${nativeCursor ?? ''}`

  if (candidates.length > page.length || earlierNative) {
    result.older = `n${firstNative ?? emptyNativeCursor ?? carried};r${firstReply ?? replyCursor ?? ''}`
  }

  return result
}
