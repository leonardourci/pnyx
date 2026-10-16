import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { HydraEvent, HydraState, Card, ReplyState } from '../core/model.ts'
import { hydraDir, readEventsFrom } from '../store/hydra-store.ts'
import { redact, transcriptMessages } from '../oracle/text.ts'
import { HOST_LABEL, replyRoute, type ReplyRoute } from '../core/route.ts'
import { traces, viewFor } from '../core/view.ts'
import { taskReceipt } from './task.ts'
import { cardSessionId } from '../core/tasks.ts'

// messageId and part let the Hydra rejoin a long message split into transport chunks.
export interface ThreadEntry { id: string; role: string; kind: 'message' | 'tool' | 'thinking'; text: string; at?: string; receipt?: ReplyState; delivery?: { agent?: { state: ReplyState; detail?: string }; hydra: { state: ReplyState; detail?: string } }; task?: string; initial?: boolean; replyId?: string; messageId?: string; part?: number }
export interface ThreadPage { card: string; session?: string; entries: ThreadEntry[]; unavailable?: string; older?: string; route: boolean; via?: string; routeKind?: ReplyRoute['kind']; noRoute?: string; watching: 'unknown' }
const MAX_BYTES = 10 * 1024 * 1024
// Chunk long entries instead of losing their tail. Sixty bounded entries stay
// below the socket budget even for JSON-escaped control characters.
const MAX_TEXT = 1000

export const replyEntryId = ({ reply }: { reply: string }) => `reply:${reply}`

export const splitEntry = ({ entry }: { entry: ThreadEntry }): ThreadEntry[] => {
  const text = redact({ text: entry.text })

  if (text.length <= MAX_TEXT) {
    return [{ ...entry, text }]
  }

  const parts: ThreadEntry[] = []

  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_TEXT, text.length)
    const last = text.charCodeAt(end - 1)

    if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
      end--
    }

    parts.push({ ...entry, id: `${entry.id}.${start}`, messageId: entry.id, part: start, text: text.slice(start, end), role: start ? `${entry.role} · continued` : entry.role })
    start = end
  }

  return parts
}

const obj = ({ v }: { v: unknown }): Record<string, unknown> => typeof v === 'object' && v !== null ? v as Record<string, unknown> : {}

export function recordEntries({ record, offset, tools = true, thinking = true }: {
  record: unknown
  offset: number
  tools?: boolean
  thinking?: boolean
}): ThreadEntry[] {
  const r = obj({ v: record })

  if (r.isMeta === true) {
    return []
  }

  const payload = obj({ v: r.payload }), message = obj({ v: r.message })
  const role = typeof payload.role === 'string' ? payload.role : String(r.type)
  const at = typeof r.timestamp === 'string' ? r.timestamp : undefined
  const entries: ThreadEntry[] = transcriptMessages({ record }).map((m, i) => ({ id: `${offset}:m${i}`, kind: 'message', role, text: m.text, at: m.at }))
  const blocks = Array.isArray(message.content) ? message.content : r.type === 'response_item' ? [payload] : []

  for (const [i, raw] of blocks.entries()) {
    const b = obj({ v: raw })
    const kind = ['tool_use', 'tool_result', 'function_call', 'function_call_output'].includes(String(b.type)) ? 'tool' : ['thinking', 'reasoning'].includes(String(b.type)) ? 'thinking' : null

    if (!kind || (kind === 'tool' && !tools) || (kind === 'thinking' && !thinking)) {
      continue
    }

    const text = b.thinking ?? b.summary ?? b.content ?? b.output ?? b.arguments ?? b.input ?? 'Recorded details unavailable'
    entries.push({ id: `${offset}:t${i}`, kind, role: typeof b.name === 'string' ? b.name : kind, at, text: typeof text === 'string' ? text : JSON.stringify(text) })
  }

  return entries.flatMap(entry => splitEntry({ entry }))
}

export function threadPath({ card }: { card: Card }): string | undefined {
  const path = card.agent?.transcriptPath

  return path && isAbsolute(path) && path.endsWith('.jsonl') && ['claude', 'claude-code', 'codex'].includes(card.agent!.provider) ? path : undefined
}

export interface LatestMessage { role: 'user' | 'assistant'; text: string; at?: string }
const LATEST_TEXT = 280
const LATEST_WINDOW = 64 * 1024

// Cut to LATEST_TEXT, never inside a surrogate pair.
function clip({ text }: { text: string }): string {
  if (text.length <= LATEST_TEXT) {
    return text
  }

  const cut = text.slice(0, LATEST_TEXT - 1).replace(/[\uD800-\uDBFF]$/, '')

  return `${cut.trimEnd()}…`
}

// Only agent-authored text can become a card update.
function lastMessage({ lines }: { lines: string[] }): LatestMessage | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: unknown

    try {
      record = JSON.parse(lines[i]!)
    } catch {
      continue
    }

    const messages = transcriptMessages({ record })

    const r = obj({ v: record }), role = obj({ v: r.payload }).role ?? r.type

    if (!messages.length || !['assistant', 'response_item'].includes(String(role))) {
      continue
    }

    const text = redact({ text: messages.map(m => m.text).join(' ') }).replace(/\s+/g, ' ')
      .trim()

    return {
      role: 'assistant',
      text: clip({ text }),
      ...(messages[0]!.at ? { at: messages[0]!.at } : {}),
    }
  }

  return null
}

// A transcript's last message and how far it was read: size is the end of its last
// complete line, so a later read of the same file parses only what was appended.
export interface LatestRead {
  message: LatestMessage | null
  path: string
  ino: number
  size: number
}

// Given the previous read of the same, grown file, parses only the complete lines
// appended since and keeps the previous message when they hold none. Otherwise reads
// back from the end: a window of tool output doubles until a message turns up or
// MAX_BYTES is read. message is null when the file holds no message or is unreadable.
export function latestMessage({ path, prev }: { path: string; prev?: LatestRead }): LatestRead {
  let fd: number | undefined

  try {
    fd = openSync(path, 'r')
    const { size, ino } = fstatSync(fd)

    // Complete lines from start: the last may still be written.
    const read = ({ start }: { start: number }) => {
      const buf = Buffer.alloc(size - start)
      readSync(fd!, buf, 0, buf.length, start)
      const end = buf.lastIndexOf(10) + 1

      return {
        lines: buf.toString('utf8', 0, end).split('\n')
          .slice(0, -1),
        size: start + end,
      }
    }

    const grown = prev?.path === path && prev.ino === ino && prev.size <= size

    if (prev && grown && size - prev.size <= MAX_BYTES) {
      const { lines, size: end } = read({ start: prev.size })

      return { message: lastMessage({ lines }) ?? prev.message, path, ino, size: end }
    }

    for (let window = LATEST_WINDOW; ; window *= 2) {
      const start = Math.max(0, size - Math.min(window, MAX_BYTES))
      const { lines, size: end } = read({ start })
      // The first line may be cut by the window.
      const message = lastMessage({ lines: lines.slice(start ? 1 : 0) })

      if (message || !start || window >= MAX_BYTES) {
        return { message, path, ino, size: end }
      }
    }
  } catch {
    return { message: null, path, ino: 0, size: 0 }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

// A cursor carries each sources position, so paging cannot skip transcript
// chunks when reply receipts also fill the latest page.
export const THREAD_CURSOR = /^n(\d+:\d+)?;r(\d+:\d+)?$/
const PAGE = 60
type RepliedEvent = Extract<HydraEvent, { type: 'card.replied' }>
type ChatEvent = Extract<HydraEvent, { type: 'chat.message' }>
type LoggedMessage = RepliedEvent | ChatEvent
const replyLogs = new Map<string, { end: number; events: LoggedMessage[] }>()

function repliedEvents({ hydraId }: { hydraId: string }): LoggedMessage[] {
  const dir = hydraDir({ hydraId })
  let log = replyLogs.get(dir) ?? { end: 0, events: [] }
  let read = readEventsFrom({ hydraId, offset: log.end })

  if (!read) {
    log = { end: 0, events: [] }; read = readEventsFrom({ hydraId, offset: 0 })
  }

  const added = (read?.events ?? []).filter((e): e is LoggedMessage =>
    (e.type === 'card.replied' && !!e.data.text) || e.type === 'chat.message')
  log = { end: read?.end ?? 0, events: added.length ? [...log.events, ...added] : log.events }
  replyLogs.set(dir, log)

  return log.events
}

export function readThread(
  { hydraId, state, card, homes, before }: {
    hydraId: string
    state: HydraState
    card: Card
    homes: string[]
    before?: string
  },
): ThreadPage {
  const found = replyRoute({ card, homes })
  const result: ThreadPage = {
    card: card.id,
    ...(cardSessionId({ card }) ? { session: cardSessionId({ card }) } : {}),
    entries: [],
    route: 'route' in found,
    ...('route' in found ? { via: HOST_LABEL[found.route.kind], routeKind: found.route.kind } : { noRoute: found.reason }),
    watching: 'unknown',
  }
  const match = before === undefined ? null : THREAD_CURSOR.exec(before)
  const nativeCursor = match?.[1], replyCursor = match?.[2]
  let candidates: { item: ThreadEntry; native?: string; reply?: string }[] = []
  let earlierNative = false, emptyNativeCursor: string | undefined
  const path = threadPath({ card })
  const { tools, thinking } = traces({ view: viewFor({ state }), card: card.id })

  if (path) {
    let fd: number | undefined

    try {
      fd = openSync(path, 'r')
      const stat = fstatSync(fd)

      if (!stat.isFile()) {
        throw new Error('not a regular file')
      }

      const [offsetText, itemText] = (nativeCursor ?? `${stat.size}`).split(':')
      const beforeOffset = Number(offsetText)
      const beforeItem = itemText === undefined ? undefined : Number(itemText)
      let end = Math.min(beforeOffset, stat.size)

      // Include the record containing a chunk cursor, then exclude chunks at or
      // after that ordinal below. A single read stays within the 10 MB window.
      if (beforeItem !== undefined) {
        const tail = Buffer.alloc(Math.min(MAX_BYTES, stat.size - end))
        readSync(fd, tail, 0, tail.length, end)
        const newline = tail.indexOf(10)
        end += newline < 0 ? tail.length : newline + 1
      }

      let start = end, parsed = end

      // Each doubling parses only the bytes before the lines already parsed.
      for (let size = 64 * 1024; ; size *= 2) {
        start = Math.max(0, end - Math.min(size, MAX_BYTES))
        const buf = Buffer.alloc(parsed - start)
        readSync(fd, buf, 0, buf.length, start)
        const first = start ? buf.indexOf(10) + 1 : 0
        const found: typeof candidates = []
        let cursor = first

        while (cursor >= 0 && cursor < buf.length) {
          const newline = buf.indexOf(10, cursor)

          if (newline < 0) {
            break
          }

          try {
            const offset = start + cursor
            const record = JSON.parse(buf.subarray(cursor, newline).toString())
            // Hidden traces must not use up the conversation page.
            recordEntries({ record, offset, tools, thinking }).forEach((item, index) => {
              if (
                beforeItem === undefined
                || offset < beforeOffset
                || (offset === beforeOffset && index < beforeItem)
              ) {
                found.push({ native: `${offset}:${index}`, item })
              }
            })
          } catch { /* Unsupported or incomplete records are not messages. */ }

          cursor = newline + 1
        }

        candidates = found.concat(candidates)

        if (first || !start) {
          parsed = start + first
        }

        if (!start || candidates.length >= PAGE || size >= MAX_BYTES) {
          break
        }
      }

      earlierNative = start > 0

      if (!candidates.length && start > 0) {
        emptyNativeCursor = `${start}:0`
      }
    } catch {
      result.unavailable = 'The recorded transcript is unavailable.'
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
      }
    }
  } else {
    result.unavailable = 'No supported transcript is recorded for this session.'
  }

  const [replySeq, replyPart] = replyCursor?.split(':').map(Number) ?? [Infinity, Infinity]
  let archived = false

  const seenReplies = new Set<string>()

  for (const e of repliedEvents({ hydraId })) {
    if (e.type === 'chat.message') {
      const session = cardSessionId({ card })

      const sameSession = session && e.data.session === session
      const participant = e.cardId === card.id || sameSession

      if ((!result.unavailable && sameSession) || !participant || e.seq > replySeq!) {
        continue
      }

      splitEntry({ entry: { id: e.id, role: e.data.role, kind: 'message', text: e.data.text, at: e.at } }).forEach((item, index) => {
        if (e.seq < replySeq! || index < replyPart!) {
          candidates.push({ item, reply: `${e.seq}:${index}` })
          archived = true
        }
      })
      continue
    }

    if (e.cardId !== card.id || e.seq > replySeq! || seenReplies.has(e.data.reply)) {
      continue
    }

    seenReplies.add(e.data.reply)
    const receipt = taskReceipt({ card: state.cards[card.id] ?? card, reply: e.data.reply })
    splitEntry({ entry: { id: replyEntryId({ reply: e.data.reply }), replyId: e.data.reply, role: 'You', kind: 'message', text: e.data.text!, at: e.at, receipt: 'queued', ...receipt, ...(e.data.reply.startsWith('brief:') ? { initial: true } : {}) } }).forEach((item, index) => {
      if (e.seq < replySeq! || index < replyPart!) {
        candidates.push({ item, reply: `${e.seq}:${index}` })
      }
    })
  }

  if (archived) {
    result.unavailable = 'Showing stored messages; the native transcript is unavailable.'
  }

  candidates.sort((a,b) => (a.item.at ?? '').localeCompare(b.item.at ?? ''))
  const page = candidates.slice(-PAGE)
  result.entries = page.map(e => e.item)

  if (candidates.length > page.length || earlierNative) {
    result.older = `n${page.find(e => e.native)?.native ?? emptyNativeCursor ?? nativeCursor ?? ''};r${page.find(e => e.reply)?.reply ?? replyCursor ?? ''}`
  }

  return result
}
