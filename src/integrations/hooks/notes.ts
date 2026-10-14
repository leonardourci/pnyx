// Notes a harness already wrote into a session transcript the hooks recorded, read
// as written and never generated: Claude Code's compaction summaries, older summary
// records and session titles, the questions it asked through AskUserQuestion with
// the user's answers, and Codex's compaction summaries. Pure: one record in, its
// notes out.
import { SESSION_TITLE, type Note, type SourceNote } from '../../core/model.ts'

// The fixed opening Claude Code puts before a compaction summary.
const COMPACT_PREAMBLE = /^This session is being continued from a previous conversation[^\n]*\n+(?:Summary:\s*\n)?/

type Rec = {
  type?: unknown
  uuid?: unknown
  timestamp?: unknown
  isCompactSummary?: unknown
  summary?: unknown
  leafUuid?: unknown
  customTitle?: unknown
  aiTitle?: unknown
  message?: { content?: unknown }
  toolUseResult?: unknown
  payload?: { message?: unknown }
}

const str = ({ value } : { value: unknown }): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

function contentText({ content } : { content: unknown }): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content.map(b => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
}

// The user's answers to one AskUserQuestion call, one decision per answered question.
function answers({ r, at } : { r: Rec; at: string | undefined }): SourceNote[] {
  const result = r.toolUseResult as {
    questions?: unknown
    answers?: unknown
    annotations?: unknown
  } | undefined

  if (typeof result !== 'object' || result === null || !Array.isArray(result.questions)) {
    return []
  }

  const given = result.answers

  if (typeof given !== 'object' || given === null) {
    return []
  }

  const call = Array.isArray(r.message?.content)
    ? (r.message.content as { tool_use_id?: unknown }[]).find(b => str({ value: b?.tool_use_id }))
    : undefined
  const id = str({ value: call?.tool_use_id }) ?? str({ value: r.uuid })

  if (!id) {
    return []
  }

  const notes = (result.annotations ?? {}) as Record<string, { notes?: unknown } | undefined>

  return result.questions.flatMap((q: { question?: unknown }, i: number) => {
    const question = str({ value: q?.question })
    const answer = question && str({ value: (given as Record<string, unknown>)[question] })

    if (!question || !answer) {
      return []
    }

    const note = str({ value: notes[question]?.notes })
    const text = [question, `Answer: ${answer}`, ...(note ? [`Notes: ${note}`] : [])].join('\n')

    return [{ kind: 'decision' as const, source: 'claude-code', text, ref: `ask:${id}:${i}`, ...(at ? { at } : {}) }]
  })
}

export function transcriptNotes({ record } : { record: unknown }): SourceNote[] {
  const r = record as Rec | null

  if (typeof r !== 'object' || r === null) {
    return []
  }

  const at = str({ value: r.timestamp })
  const note = ({ kind, source, text, ref } : { kind: Note['kind']; source: string; text: string | undefined; ref: string }): SourceNote[] =>
    text ? [{ kind, source, text, ref, ...(at ? { at } : {}) }] : []

  switch (r.type) {
    case 'user':
      if (r.isCompactSummary === true) {
        const text = str({ value: contentText({ content: r.message?.content }).replace(COMPACT_PREAMBLE, '') })

        return note({ kind: 'summary', source: 'claude-code', text, ref: `compact:${str({ value: r.uuid }) ?? text}` })
      }

      return answers({ r, at })
    case 'summary': {
      const text = str({ value: r.summary })

      return note({ kind: 'summary', source: 'claude-code', text, ref: `summary:${str({ value: r.leafUuid }) ?? ''}:${text}` })
    }
    case 'custom-title':
    case 'ai-title': {
      const title = str({ value: r.customTitle }) ?? str({ value: r.aiTitle })

      return note({ kind: 'context', source: 'claude-code', text: title && `${SESSION_TITLE}${title}`, ref: `title:${title}` })
    }
    case 'compacted': {
      // Codex's local compaction keeps its summary here; a remote one is encrypted and leaves it empty.
      const text = str({ value: r.payload?.message })

      return note({ kind: 'summary', source: 'codex', text, ref: `compacted:${at ?? ''}:${text}` })
    }
    default:
      return []
  }
}

// The thread name Codex last recorded for this session in its session_index.jsonl,
// one {id, thread_name, updated_at} record per line, later lines newer.
export function codexThreadTitle({ index, sessionId } : {
  index: string
  sessionId: string
}): SourceNote[] {
  let title: string | undefined
  let at: string | undefined

  for (const line of index.split('\n')) {
    try {
      const r = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown }

      if (r.id === sessionId && str({ value: r.thread_name })) {
        title = str({ value: r.thread_name })
        at = str({ value: r.updated_at })
      }
    } catch {
      // A torn or foreign line names no thread.
    }
  }

  return title
    ? [{ kind: 'context', source: 'codex', text: `${SESSION_TITLE}${title}`, ref: `title:${at ?? ''}:${title}`, ...(at ? { at } : {}) }]
    : []
}
