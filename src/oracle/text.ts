import type { Attention, HydraEvent } from '../core/model.ts'

// Bump when chunk() or the filters change what is indexed; the index rebuilds on mismatch.
export const CHUNKER_VERSION = 4

// About 256 tokens at 3 characters a token.
const CHUNK_MAX = 768

const SECRETS = [
  /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

// Text a harness injects into a user turn: reminders, hook output, command tags,
// Codex's context blocks and the AGENTS.md instructions Codex adds under a header line.
const INJECTED = /(?:# AGENTS\.md instructions for [^\n]*\s*)?<(system-reminder|environment_context|user_instructions|INSTRUCTIONS|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|user-prompt-submit-hook|pnyx-wake)>[\s\S]*?<\/\1>/g

export function redact({ text }: { text: string }): string {
  return SECRETS.reduce((t, re) => t.replace(re, '[redacted]'), text)
}

// Paragraphs, keeping a fenced code block whole.
function paragraphs({ text }: { text: string }): string[] {
  const out: string[] = []
  let current: string[] = []
  let fenced = false

  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
    }

    if (!fenced && line.trim() === '') {
      if (current.length) {
        out.push(current.join('\n'))
      }

      current = []
    } else {
      current.push(line)
    }
  }

  if (current.length) {
    out.push(current.join('\n'))
  }

  return out
}

function pieces({ paragraph }: { paragraph: string }): string[] {
  if (paragraph.length <= CHUNK_MAX) {
    return [paragraph]
  }

  const out: string[] = []
  let current = ''

  for (let line of paragraph.split('\n')) {
    while (line.length > CHUNK_MAX) {
      const cut = line.lastIndexOf(' ', CHUNK_MAX) > CHUNK_MAX / 2 ? line.lastIndexOf(' ', CHUNK_MAX) : CHUNK_MAX

      if (current) {
        out.push(current)
      }

      out.push(line.slice(0, cut))
      current = ''
      line = line.slice(cut).trimStart()
    }

    if (current && current.length + 1 + line.length > CHUNK_MAX) {
      out.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }

  if (current) {
    out.push(current)
  }

  return out
}

// A pure function of the text: one chunk for a short message; a long one packs
// paragraphs up to the limit, each chunk after the first repeating the previous
// chunk's last paragraph when it fits.
export function chunk({ text }: { text: string }): string[] {
  const t = text.trim()

  if (t.length <= CHUNK_MAX) {
    return t ? [t] : []
  }

  const units = paragraphs({ text: t }).flatMap(paragraph => pieces({ paragraph }))
  const chunks: string[] = []
  let current: string[] = []
  let size = 0

  for (const unit of units) {
    if (current.length && size + 2 + unit.length > CHUNK_MAX) {
      chunks.push(current.join('\n\n'))
      const last = current.at(-1)!
      current = current.length > 1 && last.length + 2 + unit.length <= CHUNK_MAX ? [last] : []
      size = current.length ? last.length : 0
    }

    size += (current.length ? 2 : 0) + unit.length
    current.push(unit)
  }

  if (current.length) {
    chunks.push(current.join('\n\n'))
  }

  return chunks
}

const attentionText = ({ list }: { list: Attention[] | undefined }) => (list ?? []).map(a => a.text)

export function eventText({ event }: { event: HydraEvent }): string {
  const parts: (string | undefined)[] = [event.reason]

  switch (event.type) {
    case 'chat.message':
      parts.push(event.data.text)
      break
    case 'task.reminder':
      parts.push(event.data.after ?? 'Reminder cleared')
      break
    case 'task.reminder-due':
      parts.push(event.data.message.text)
      break
    case 'task.created':
      parts.push(event.data.title)
      break
    case 'task.declared':
      parts.push(event.data.state, event.data.note, event.data.raw)
      break
    case 'task.mirrored':
      parts.push(
        event.data.status,
        JSON.stringify(event.data.meta),
        JSON.stringify(event.data.backlog),
      )
      break
    case 'hydra.message':
      parts.push(event.data.text, event.data.details)
      break
    case 'board.agents':
      parts.push(...Object.keys(event.data.agents))
      break
    case 'board.configured':
      parts.push(event.data.name, event.data.hydra.name)
      break
    case 'board.columns':
      parts.push(...event.data.columns.map(c => c.title))
      break
    case 'card.pushed': {
      const { data } = event
      const changed = ({ field }: { field: string }) => !data.before || field in data.before

      if (changed({ field: 'title' })) {
        parts.push(data.title ?? undefined)
      }

      if (changed({ field: 'tags' })) {
        parts.push(...(data.tags ?? []).filter(t => !data.before?.tags?.includes(t)))
      }

      if (changed({ field: 'attention' })) {
        const known = attentionText({ list: data.before?.attention })
        parts.push(...attentionText({ list: data.attention }).filter(t => !known.includes(t)))
      }

      break
    }
    case 'card.linked': {
      const { before, after } = event.data

      if (after && (!before || before.title !== after.title || before.url !== after.url)) {
        parts.push([after.number === undefined ? '' : `#${after.number}`, after.title, after.url].filter(Boolean).join(' '))
      }

      break
    }
    case 'card.outcome':
      parts.push(event.data.after?.note)
      break
    case 'card.replied':
      parts.push(event.data.text)
      break
    case 'card.noted':
      parts.push(event.data.text)
      break
    case 'card.moved':
      break
  }

  return parts.filter(Boolean).join('\n')
}

export interface Message {
  at?: string
  text: string
}

const TEXT_BLOCKS = ['text', 'input_text', 'output_text']

// The typed user messages and assistant text blocks of one Claude Code or Codex
// transcript record. Tool calls and results, thinking, images, meta records,
// developer messages and injected text are left out, and so is a compaction
// summary, which is harvested as a note instead.
export function transcriptMessages({ record }: { record: unknown }): Message[] {
  type Record = {
    type?: unknown
    isMeta?: unknown
    isCompactSummary?: unknown
    timestamp?: unknown
    message?: { content?: unknown }
    payload?: { type?: unknown; role?: unknown; content?: unknown }
  }
  const r = record as Record | null

  if (typeof r !== 'object' || r === null || r.isMeta === true || r.isCompactSummary === true) {
    return []
  }

  const codex = r.type === 'response_item'
    && r.payload?.type === 'message'
    && (r.payload.role === 'user' || r.payload.role === 'assistant')

  if (!codex && r.type !== 'user' && r.type !== 'assistant') {
    return []
  }

  const content = codex ? r.payload!.content : r.message?.content
  const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content : []
  const at = typeof r.timestamp === 'string' ? r.timestamp : undefined

  return blocks
    .map(b => (typeof b === 'string' ? b : TEXT_BLOCKS.includes(b?.type) && typeof b.text === 'string' ? (b.text as string) : ''))
    .map(t => t.replace(INJECTED, '').trim())
    .filter(Boolean)
    .map(text => (at ? { at, text } : { text }))
}
