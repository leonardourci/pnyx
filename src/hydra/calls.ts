import { commandOf } from '#workers/tool-input.ts'

export { commandOf, SHELL_WRAPPER } from '#workers/tool-input.ts'
import type { NativeWork } from '#workers/provider.ts'
import { redact } from '#oracle/text.ts'

export const obj = ({ v }: { v: unknown }): Record<string, unknown> => typeof v === 'object' && v !== null ? v as Record<string, unknown> : {}

// One call the agent made, kept to what the page needs to name it.
export interface ToolCall {
  // Pairs the call with its result.
  id: string
  tool: string
  command?: string
  file?: string
  query?: string
  url?: string
  skill?: string
  // The agent's own one-line words for the call, when its tool takes them.
  description?: string
}

// The agent's latest calls, made together; done once each has its result back.
export interface CurrentAction {
  work?: NativeWork
  thinking?: boolean
  calls: ToolCall[]
  at?: string
  done: boolean
}

// Where a transcript read left the agent's calls, so the next read of the grown file carries on.
export interface ActionRead {
  action: CurrentAction | null
  answered: string[]
  // The read ended inside the action's run of calls, so calls in the next lines join it.
  open: boolean
}

export interface RecordCalls {
  calls: ToolCall[]
  results: string[]
  at?: string
}

export const LINE_MAX = 120
const COMMAND_MAX = 400
const CALL_FIELDS = [
  'command',
  'file',
  'query',
  'url',
  'skill',
  'description',
] as const

// Cut to max with an ellipsis, never inside a surrogate pair.
export function shortened({
  text,
  max,
}: {
  text: string
  max: number
}): string {
  if (text.length <= max) {
    return text
  }

  const cut = text.slice(
    0,
    max - 1,
  ).replace(
    /[\uD800-\uDBFF]$/,
    '',
  )

  return `${cut.trimEnd()}…`
}

export function firstLine({ text }: { text: string }): string {
  return shortened({
    text: text.trim().split('\n')[0] ?? '',
    max: LINE_MAX,
  })
}

// Redacted, so a token in a command never reaches the page.
const scrubbed = ({
  value,
  max,
}: {
  value: unknown
  max: number
}): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined
  }

  return shortened({
    text: redact({ text: value.trim() }),
    max,
  })
}

const descriptionOf = ({ input }: { input: Record<string, unknown> }) => {
  if (typeof input.description !== 'string') {
    return undefined
  }

  return firstLine({ text: input.description })
}

const fileOf = ({ input }: { input: Record<string, unknown> }): unknown => {
  const path = input.file_path ?? input.notebook_path ?? input.path

  if (typeof path !== 'string' || path.length <= LINE_MAX) {
    return path
  }

  return path.trim().replace(
    /\/+$/,
    '',
  )
    .split('/')
    .at(-1)
}

export function callOf({
  id,
  tool,
  input,
}: {
  id: string
  tool: string
  input: Record<string, unknown>
}): ToolCall {
  const fields: Record<typeof CALL_FIELDS[number], string | undefined> = {
    command: scrubbed({
      value: commandOf({ input }),
      max: COMMAND_MAX,
    }),
    file: scrubbed({
      value: fileOf({ input }),
      max: LINE_MAX,
    }),
    query: scrubbed({
      value: input.pattern ?? input.query,
      max: LINE_MAX,
    }),
    url: scrubbed({
      value: input.url,
      max: LINE_MAX,
    }),
    skill: scrubbed({
      value: input.skill ?? input.subagent_type,
      max: LINE_MAX,
    }),
    description: scrubbed({
      value: descriptionOf({ input }),
      max: LINE_MAX,
    }),
  }
  const call: ToolCall = {
    id,
    tool,
  }

  for (const name of CALL_FIELDS) {
    const value = fields[name]

    if (value !== undefined) {
      call[name] = value
    }
  }

  return call
}
