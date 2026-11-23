import { taskSessions } from '#workers/session-history.ts'
import { readEvents } from '#app/event-log.ts'
import { THREAD_PAGE_LIMIT } from './thread-history.ts'
import { log } from '#app/diagnostics.ts'
import { messageReference } from './message-reference.ts'
import { HYDRA_CARD } from './identity.ts'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentConfig, AgentRef, ReplyState } from '#workers/model.ts'
import { redact, redactFragments } from '#oracle/text.ts'
import { readTranscriptRecord } from '#workers/transcripts.ts'
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
import { hydraMessages } from './chat-messages.ts'
import { deliveredInputs, replyEchoes } from './task-messages.ts'
import { hydraConfig } from './config.ts'
import type { HydraMessage } from './model.ts'

export interface ThreadEntry {
  targetAgent?: AgentConfig
  offset?: number
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
  // A stopped message the owner already sent again.
  sentAgain?: boolean
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
  // Pnyx wrote this user input, such as a worker's start prompt.
  pnyx?: boolean
  inputUuid?: string
  replyId?: string
  messageId?: string
  part?: number
}
export interface ThreadPage {
  card: string
  session?: string
  epoch?: string
  stream?: string
  version?: number
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
  messages?: HydraMessage[]
  route: boolean
  via?: string
  routeKind?: ReplyRoute['kind']
  noRoute?: string
  watching: 'unknown'
}
const HYDRA_PAGE_SIZE = 20
const MAX_BYTES = 10 * 1024 * 1024
// Parts bound each transport entry without cutting a logical message at a page boundary.
const MAX_TEXT = 1000

const replyEntryId = ({ reply }: { reply: string }) => `reply:${reply}`

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
      messageId: entry.messageId ?? entry.id,
      part: (entry.part ?? 0) + start,
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
  path?: string
  offset: number
  tools?: boolean
  thinking?: boolean
  boundaries?: boolean
  session?: string
}

export function recordEntries({
  record,
  ...options
}: EntryOptions & { record: unknown }): ThreadEntry[] {
  return transcriptEntries({
    parsed: readTranscriptRecord({
      record,
      source: options.path ? {
        path: options.path,
        offset: options.offset,
      } : undefined,
    }),
    ...options,
  })
}

export function showsKind({
  kind,
  tools,
  thinking,
}: {
  kind: ThreadEntry['kind']
  tools: boolean
  thinking: boolean
}): boolean {
  const hiddenTool = kind === 'tool' && !tools
  const hiddenThinking = kind === 'thinking' && !thinking

  return !hiddenTool && !hiddenThinking
}

function transcriptEntries({
  parsed,
  offset,
  tools = true,
  thinking = true,
  boundaries = false,
  session,
}: EntryOptions & { parsed: TranscriptRecord }): ThreadEntry[] {
  const messages = parsed.messages.filter(message => boundaries || !message.internal)
  const fragments = messages.some(message => message.messageId !== undefined)
    ? redactFragments({ fragments: messages.map(message => message.text) })
    : messages.map(message => message.text)
  let part = 0
  const entries: ThreadEntry[] = messages.map((
    message,
    index,
  ) => {
    const entry: ThreadEntry = {
      id: message.id ?? `${offset}:m${index}`,
      offset,
      kind: 'message',
      role: parsed.role,
      text: fragments[index],
      messageId: message.messageId,
      part: message.messageId ? part : undefined,
      at: message.at,
      hidden: message.internal,
      final: parsed.final,
      block: message.block,
    }

    part += entry.text.length

    if (message.pnyx) {
      entry.pnyx = true
    }

    if (parsed.inputUuid) {
      entry.inputUuid = parsed.inputUuid
    }

    return entry
  })

  for (const trace of parsed.traces) {
    if (!showsKind({
      kind: trace.kind,
      tools,
      thinking,
    })) {
      continue
    }

    const entry: ThreadEntry = {
      id: trace.id ?? `${offset}:t${trace.index}`,
      offset,
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
  ) => (a.block ?? 0) - (b.block ?? 0)).flatMap(entry => splitEntry({
    entry: {
      ...entry,
      id: session ? `${session}:${entry.id}` : entry.id,
      messageId: entry.messageId && session ? `${session}:${entry.messageId}` : entry.messageId,
      session,
    },
  }))
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
interface HydraSession {
  session: string
  agent: AgentRef
}

// Every session Hydra has been configured with, oldest first; the card holds the current
// session's latest agent.
function hydraSessions({ state }: { state: HydraState }): HydraSession[] {
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
export const THREAD_CURSOR = /^n(?:(\d+)\.)?(\d+:\d+)?;r(\d+:\d+)?(?:;m([\w%.!~*'()-]+))?$/
type LoggedMessage = HydraEvent

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
    types: ['card.replied'],
    matches: ({ event }) => event.type === 'card.replied' && Boolean(event.data.text)
      && event.cardId === card.id,
  })

  const moved = history.some(entry => entry.hydra !== hydraId)

  return history.reverse().map((
    { event },
    index,
  ) => ({
    ...event,
    seq: moved ? index + 1 : event.seq,
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
  message?: string
}

// Earlier sessions use stable cursor indexes so a harness switch preserves pagination.
type ThreadSource = {
  session?: string
  path?: string
  index?: number
  agent?: Card['agent']
}

export function threadSources({
  hydraId,
  state,
  card,
  selectedSession,
}: {
  hydraId: string
  state: HydraState
  card: Card
  selectedSession?: boolean
}): ThreadSource[] {
  const session = cardSessionId({ card })
  const hydra = state.cards[HYDRA_CARD]
  const current = card.id === HYDRA_CARD
    && session === (hydra && cardSessionId({ card: hydra }))

  const task = card.id !== HYDRA_CARD && !selectedSession

  if (task) {
    const members = [
      ...taskSessions({
        hydraId,
        ids: new Set([card.id]),
      }),
    ]
    const previous = members.filter(id => id !== session)

    return [
      {
        session,
        path: threadPath({ card }),
        agent: card.agent,
      },
      ...previous.map(id => ({
        session: id,
        path: threadPath({ card: { agent: state.sessions?.[id]?.agent } }),
        index: members.indexOf(id),
        agent: state.sessions?.[id]?.agent,
      })).reverse(),
    ]
  }

  if (!current) {
    return [
      {
        session,
        path: threadPath({ card }),
        agent: card.agent,
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
      // Only the current session can be missing from hydraSessions, and earlier leaves it out.
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
}: {
  path: string
  session?: string
  cursor?: string
  wanted: number
  tools: boolean
  thinking: boolean
  boundaries: boolean
  excludedAt: string[]
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

          const decoded = readTranscriptRecord({
            record,
            source: {
              path,
              offset,
            },
          })

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
            session,
          }).forEach((
            item,
            index,
          ) => {
            if (
              beforeItem === undefined
              || offset < beforeOffset
              || (offset === beforeOffset && index < beforeItem)
            ) {
              const entry: ThreadEntry = {
                ...item,
                reference: session ? messageReference({
                  session,
                  id: item.id,
                  messageId: item.messageId,
                }) : undefined,
              }

              window.push({
                native: `${offset}:${index}`,
                item: entry,
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
  before?: string
  selectedSession?: boolean
  allTraces?: boolean
}

// A conversation page from the task's transcript and saved events, with a log line for how long the read took.
export function readThread({
  hydraId,
  state,
  card,
  before,
  selectedSession,
  allTraces,
}: ThreadRead): ThreadPage {
  const started = performance.now()
  const page = readThreadPage({
    hydraId,
    state,
    card,
    before,
    selectedSession,
    allTraces,
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
    before,
    selectedSession,
    allTraces,
  }: ThreadRead,
): ThreadPage {
  const found = replyRoute({ card })
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
  const tools = allTraces || card.id === HYDRA_CARD || selected.tools
  const thinking = allTraces || selected.thinking
  const sources = threadSources({
    hydraId,
    state,
    card,
    selectedSession,
  })
  const logged = threadEvents({
    hydraId,
    card,
  })
  const echoes = replyEchoes({
    card: card.id,
    events: logged,
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
      })
    } catch {
      if (current) {
        result.unavailable = 'The recorded transcript is unavailable.'
      }

      continue
    }

    let kept = read.found

    if (card.id !== HYDRA_CARD) {
      const delivered = deliveredInputs({
        entries: read.found.map(candidate => candidate.item),
        echoes,
        agent: source.agent,
      })
      kept = read.found.filter(candidate => !delivered.has(candidate.item))
    }

    candidates = [
      ...kept.map(candidate => ({
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

  const messageCursor = match?.[4] === undefined ? undefined : decodeURIComponent(match[4])
  const allMessages = card.id === HYDRA_CARD
    ? (state.hydraMessages ?? []).filter(message =>
      message.hydra === hydraConfig({ state }).hydra.id)
      .toSorted((
        a,
        b,
      ) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    : []
  const messageEnd = messageCursor === undefined ? allMessages.length
    : Math.max(
      0,
      allMessages.findIndex(message => message.id === messageCursor),
    )
  const messages = allMessages.slice(
    0,
    messageEnd,
  )
  const originals = new Map(candidates.map(candidate => [
    candidate.item.id,
    candidate,
  ]))

  if (card.id === HYDRA_CARD) {
    const messageIds = new Set(messages.map(message => message.id))
    candidates = hydraMessages({
      messages,
      transcript: candidates.map(candidate => candidate.item),
      provider: card.agent?.provider,
      boundaries: true,
    }).map(item => ({
      ...originals.get(item.id),
      item,
      message: item.reference && messageIds.has(item.reference) ? item.reference : undefined,
    }))
  }

  candidates.sort((
    a,
    b,
  ) => threadEntryOrder({
    first: a.item,
    second: b.item,
  }))
  const limit = card.id === HYDRA_CARD ? HYDRA_PAGE_SIZE : THREAD_PAGE_LIMIT
  let pageStart = Math.max(
    0,
    candidates.length - limit,
  )
  const firstMessageId = candidates[pageStart]?.item.messageId

  while (pageStart > 0 && firstMessageId !== undefined
    && candidates[pageStart - 1]?.item.messageId === firstMessageId) {
    pageStart--
  }

  const page = candidates.slice(pageStart)
  const firstMessage = page.find(candidate => candidate.message)?.message
  const shownMessages = new Set(page.flatMap(candidate =>
    candidate.message ? [candidate.message] : []))

  if (card.id === HYDRA_CARD) {
    result.messages = messages.filter(message => shownMessages.has(message.id))
  }

  const firstNative = page.find(candidate => candidate.native)?.native
  const firstReply = page.find(candidate => candidate.reply)?.reply
  result.entries = page.filter(candidate => !candidate.message).map(candidate => candidate.item)

  if (card.id === HYDRA_CARD) {
    const firstAt = page[0]?.item.at
    const beforeAt = excludedAt.toSorted()[0]
    const events = firstAt === undefined ? [] : readEvents({ hydraId }).filter(event =>
      event.at >= firstAt && (beforeAt === undefined || event.at <= beforeAt)
      && ((event.type === 'card.replied' && event.data.text) || (event.actor === 'hydra' && event.type !== 'hydra.message')))
    result.actions = events.filter(event => threadAction({
      event,
      state,
    }))
  }

  const oldestMessage = firstMessage ?? messageCursor
  const messagePosition = oldestMessage === undefined ? '' : `;m${encodeURIComponent(oldestMessage)}`
  const carriedSource = sourceCursor === undefined ? '' : `${sourceCursor}.`
  const carried = `${carriedSource}${nativeCursor ?? ''}`

  if (candidates.length > page.length || earlierNative) {
    result.older = `n${firstNative ?? emptyNativeCursor ?? carried};r${firstReply ?? replyCursor ?? ''}${messagePosition}`
  }

  return result
}
