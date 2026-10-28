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
const MAX_CALLS = 8
// Codex's code mode runs every tool from one script passed to this tool.
const CODE_MODE_TOOL = 'exec'
export const SHELL_WRAPPER = /(^|\/)(ba|z)?sh$/
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

// Claude's Bash input is {command}; Codex's shell calls carry {cmd} or an argv list.
export function commandOf({ input }: { input: Record<string, unknown> }): string | undefined {
  const value = input.command ?? input.cmd

  if (typeof value === 'string') {
    return value
  }

  if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) {
    return undefined
  }

  const [
    program,
    flag,
    script,
  ] = value
  const wrapsScript = value.length === 3 && SHELL_WRAPPER.test(program ?? '') && !!flag?.startsWith('-')

  return wrapsScript ? script : value.join(' ')
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

function callOf({
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

// A script calls tools.exec_command({cmd:"git status"}) and friends; a patch names its files on "*** Update File:" lines.
const SCRIPT_CALL = /tools\.(\w+)\(/g
const SCRIPT_COMMAND = /["']?cmd["']?\s*:\s*("(?:[^"\\]|\\.)*")/
const SCRIPT_PATH = /["']?path["']?\s*:\s*("(?:[^"\\]|\\.)*")/
const PATCHED_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m

const scriptString = ({
  pattern,
  text,
}: {
  pattern: RegExp
  text: string
}): string | undefined => {
  const literal = pattern.exec(text)?.[1]

  if (literal === undefined) {
    return undefined
  }

  try {
    return String(JSON.parse(literal))
  } catch {
    return undefined
  }
}

function scriptCalls({
  id,
  script,
}: {
  id: string
  script: string
}): ToolCall[] {
  const starts = [...script.matchAll(SCRIPT_CALL)]

  return starts.map((
    match,
    index,
  ) => {
    const body = script.slice(
      match.index + match[0].length,
      starts[index + 1]?.index ?? script.length,
    )
    const path = scriptString({
      pattern: SCRIPT_PATH,
      text: body,
    }) ?? PATCHED_FILE.exec(body)?.[1]

    return callOf({
      id,
      tool: match[1]!,
      input: {
        cmd: scriptString({
          pattern: SCRIPT_COMMAND,
          text: body,
        }),
        path,
      },
    })
  })
}

function customCalls({
  id,
  tool,
  input,
}: {
  id: string
  tool: string
  input: string
}): ToolCall[] {
  if (tool === CODE_MODE_TOOL) {
    return scriptCalls({
      id,
      script: input,
    })
  }

  return [
    callOf({
      id,
      tool,
      input: { path: PATCHED_FILE.exec(input)?.[1] },
    }),
  ]
}

const parsedArguments = ({ text }: { text: unknown }): Record<string, unknown> => {
  try {
    return obj({ v: typeof text === 'string' ? JSON.parse(text) : text })
  } catch {
    return {}
  }
}

// A Claude record carries a list of content blocks; a Codex record is one block.
export function recordBlocks({ record }: { record: unknown }): unknown[] {
  const entry = obj({ v: record })
  const message = obj({ v: entry.message })

  if (Array.isArray(message.content)) {
    return message.content
  }

  if (entry.type === 'response_item') {
    return [entry.payload]
  }

  return []
}

// A subagent's own records stay out: its parent's call already names what it is doing.
export function recordCalls({ record }: { record: unknown }): RecordCalls {
  const entry = obj({ v: record })
  const found: RecordCalls = {
    calls: [],
    results: [],
  }

  if (typeof entry.timestamp === 'string') {
    found.at = entry.timestamp
  }

  if (entry.isMeta === true || entry.isSidechain === true) {
    return found
  }

  for (const raw of recordBlocks({ record })) {
    const block = obj({ v: raw })
    const tool = typeof block.name === 'string' ? block.name : 'tool'

    switch (block.type) {
      case 'tool_use':
        if (typeof block.id === 'string') {
          found.calls.push(callOf({
            id: block.id,
            tool,
            input: obj({ v: block.input }),
          }))
        }

        break
      case 'function_call':
        if (typeof block.call_id === 'string') {
          found.calls.push(callOf({
            id: block.call_id,
            tool,
            input: parsedArguments({ text: block.arguments }),
          }))
        }

        break
      case 'custom_tool_call':
        if (typeof block.call_id === 'string' && typeof block.input === 'string') {
          found.calls.push(...customCalls({
            id: block.call_id,
            tool,
            input: block.input,
          }))
        }

        break
      case 'tool_result':
        if (typeof block.tool_use_id === 'string') {
          found.results.push(block.tool_use_id)
        }

        break
      case 'function_call_output':
      case 'custom_tool_call_output':
        if (typeof block.call_id === 'string') {
          found.results.push(block.call_id)
        }

        break
    }
  }

  return found
}

const parsed = ({ line }: { line: string }): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

// Calls written back to back are one run, the agent's current action; a later run replaces it.
export function readAction({
  lines,
  prev,
}: {
  lines: string[]
  prev?: ActionRead
}): ActionRead {
  let calls = prev?.action?.calls ?? []
  let at = prev?.action?.at
  let open = prev?.open ?? false
  const answered = new Set(prev?.answered)

  for (const line of lines) {
    const record = parsed({ line })

    if (record === undefined) {
      continue
    }

    const found = recordCalls({ record })

    if (found.calls.length && open) {
      calls = [
        ...calls,
        ...found.calls,
      ]
    } else if (found.calls.length) {
      calls = found.calls
      at = found.at
      answered.clear()
    }

    open = found.calls.length > 0

    for (const id of found.results) {
      if (calls.some(call => call.id === id)) {
        answered.add(id)
      }
    }
  }

  if (!calls.length) {
    return {
      action: null,
      answered: [],
      open: false,
    }
  }

  const kept = calls.slice(-MAX_CALLS)
  const action: CurrentAction = {
    calls: kept,
    done: kept.every(call => answered.has(call.id)),
  }

  if (at) {
    action.at = at
  }

  return {
    action,
    answered: [...answered],
    open,
  }
}
