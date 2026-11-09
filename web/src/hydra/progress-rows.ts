import { callOf, obj, type ToolCall } from '#hydra/calls.ts'
import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import { transcriptCall } from '#workers/transcript-content.ts'
import { actionLabel, type ActionLabel } from './action-label.ts'
import { shellCommand, type PnyxLookup } from './pnyx-action.ts'

// A tool result is recorded under this role; the call itself carries the tool's name.
const RESULT_ROLE = 'tool'

interface ToolRow {
  kind: 'tool'
  entry: ThreadEntry
  call?: ToolCall
  // What the row shows once opened: the shell command, else the call's input as indented JSON.
  input?: string
  output?: string
}

export type TraceRow = ToolRow | {
  kind: 'thinking'
  entry: ThreadEntry
}

export type ProgressRow = TraceRow | {
  kind: 'message'
  entry: ThreadEntry
}

const parsedInput = ({ text }: { text: string }) => {
  try {
    return obj({ v: JSON.parse(text) })
  } catch {
    return undefined
  }
}

const shownInput = ({
  text,
  input,
}: {
  text: string
  input?: Record<string, unknown>
}) => shellCommand({ text }) ?? (input ? JSON.stringify(
  input,
  null,
  2,
) : text)

function toolRow({ entry }: { entry: ThreadEntry }): ToolRow {
  if (entry.role === RESULT_ROLE) {
    return {
      kind: 'tool',
      entry,
      output: entry.text,
    }
  }

  const input = parsedInput({ text: entry.text })

  return {
    kind: 'tool',
    entry,
    call: callOf(transcriptCall({
      id: entry.call ?? entry.id,
      tool: entry.role,
      input: input ?? {},
    })),
    input: shownInput({
      text: entry.text,
      input,
    }),
  }
}

// One row per update: a tool's result joins its call's row when both are in the same progress.
export function progressRows({ notes }: { notes: ThreadEntry[] }): ProgressRow[] {
  const rows: ProgressRow[] = []
  const calls = new Map<string, ToolRow>()

  for (const entry of notes) {
    // Redacted thinking has no words to show.
    if (entry.kind === 'thinking' && !entry.text.trim()) {
      continue
    }

    if (entry.kind !== 'tool') {
      rows.push(entry.kind === 'thinking' ? {
        kind: 'thinking',
        entry,
      } : {
        kind: 'message',
        entry,
      })
      continue
    }

    const opened = entry.role === RESULT_ROLE && entry.call ? calls.get(entry.call) : undefined

    if (opened) {
      opened.output = [
        opened.output,
        entry.text,
      ].filter(Boolean).join('\n')
      continue
    }

    const row = toolRow({ entry })

    if (row.call && entry.call) {
      calls.set(
        entry.call,
        row,
      )
    }

    rows.push(row)
  }

  return rows
}

const THINKING: ActionLabel = {
  icon: 'thinking',
  sentence: ['Thinking'],
}

// The same words the worker cards use for a call, so a progress row never shows raw input.
export function progressLabel({
  row,
  lookup,
}: {
  row: TraceRow
  lookup: PnyxLookup
}): ActionLabel {
  if (row.kind === 'thinking') {
    return THINKING
  }

  const named = row.call && actionLabel({
    action: {
      calls: [row.call],
      done: true,
    },
    lookup,
  })

  if (named) {
    return named
  }

  return {
    icon: 'tool',
    sentence: [row.call ? `Used ${row.call.tool}` : 'Tool output'],
  }
}
