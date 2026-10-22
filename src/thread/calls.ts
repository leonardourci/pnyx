import { redact } from '../oracle/text.ts'

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
  calls: ToolCall[]
  at?: string
  done: boolean
}

const COMMAND_TEXT = 400
const WORDS_TEXT = 120
const MAX_CALLS = 8

const clipped = ({
  value,
  max,
}: {
  value: unknown
  max: number
}): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined
  }

  const text = redact({ text: value.trim() })

  return text.length > max ? text.slice(
    0,
    max,
  ) : text
}

// Claude's Bash input is {command}; Codex's shell calls carry {cmd} or an argv list.
export function commandOf({ input }: { input: Record<string, unknown> }): string | undefined {
  const value = input.command ?? input.cmd

  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value) && value.every(part => typeof part === 'string')) {
    return value.length === 3 && /(^|\/)(ba|z)?sh$/.test(value[0]) && value[1].startsWith('-') ? value[2] : value.join(' ')
  }

  return undefined
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
  const description = typeof input.description === 'string' ? input.description.trim().split('\n')[0] : undefined
  const fields = {
    command: clipped({
      value: commandOf({ input }),
      max: COMMAND_TEXT,
    }),
    file: clipped({
      value: input.file_path ?? input.notebook_path ?? input.path,
      max: WORDS_TEXT,
    }),
    query: clipped({
      value: input.pattern ?? input.query,
      max: WORDS_TEXT,
    }),
    url: clipped({
      value: input.url,
      max: WORDS_TEXT,
    }),
    skill: clipped({
      value: input.skill ?? input.subagent_type,
      max: WORDS_TEXT,
    }),
    description: clipped({
      value: description,
      max: WORDS_TEXT,
    }),
  }

  return {
    id,
    tool,
    ...Object.fromEntries(Object.entries(fields).filter(([
      , value,
    ]) => value !== undefined)),
  }
}

// Codex runs its tools from a short script, such as tools.exec_command({cmd:"git status"}),
// often several at once; a patch names its files on "*** Update File: <path>" lines.
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

  try {
    return literal === undefined ? undefined : String(JSON.parse(literal))
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

    return callOf({
      id,
      tool: match[1]!,
      input: {
        cmd: scriptString({
          pattern: SCRIPT_COMMAND,
          text: body,
        }),
        path: scriptString({
          pattern: SCRIPT_PATH,
          text: body,
        }) ?? PATCHED_FILE.exec(body)?.[1],
      },
    })
  })
}

const parsedArguments = ({ text }: { text: unknown }): Record<string, unknown> => {
  try {
    return obj({ v: typeof text === 'string' ? JSON.parse(text) : text })
  } catch {
    return {}
  }
}

// The calls a transcript record makes and the call ids it answers. A subagent's own
// records stay out: its parent's call already names what it is doing.
export function recordCalls({ record }: { record: unknown }): {
  calls: ToolCall[]
  results: string[]
  at?: string
} {
  const r = obj({ v: record })
  const calls: ToolCall[] = [], results: string[] = []

  if (r.isMeta === true || r.isSidechain === true) {
    return {
      calls,
      results,
    }
  }

  const message = obj({ v: r.message }), payload = obj({ v: r.payload })
  const blocks = Array.isArray(message.content) ? message.content : r.type === 'response_item' ? [payload] : []

  for (const raw of blocks) {
    const b = obj({ v: raw })
    const tool = String(b.name)

    if (b.type === 'tool_use') {
      calls.push(callOf({
        id: String(b.id),
        tool,
        input: obj({ v: b.input }),
      }))
    } else if (b.type === 'function_call') {
      calls.push(callOf({
        id: String(b.call_id),
        tool,
        input: parsedArguments({ text: b.arguments }),
      }))
    } else if (b.type === 'custom_tool_call' && typeof b.input === 'string') {
      calls.push(...(tool === 'exec' ? scriptCalls({
        id: String(b.call_id),
        script: b.input,
      }) : [
        callOf({
          id: String(b.call_id),
          tool,
          input: { path: PATCHED_FILE.exec(b.input)?.[1] },
        }),
      ]))
    } else if (b.type === 'tool_result') {
      results.push(String(b.tool_use_id))
    } else if (b.type === 'function_call_output' || b.type === 'custom_tool_call_output') {
      results.push(String(b.call_id))
    }
  }

  return {
    calls,
    results,
    ...(typeof r.timestamp === 'string' ? { at: r.timestamp } : {}),
  }
}

// Reads back from the end to the agent's latest run of calls, and collects the call
// ids answered after it, so an action read earlier can be marked done.
export function lastAction({ lines }: { lines: string[] }): {
  action: CurrentAction | null
  results: Set<string>
} {
  const results = new Set<string>()
  let calls: ToolCall[] = [], at: string | undefined

  for (let i = lines.length - 1; i >= 0; i--) {
    let record: unknown

    try {
      record = JSON.parse(lines[i]!)
    } catch {
      continue
    }

    const found = recordCalls({ record })

    if (found.calls.length) {
      calls = [
        ...found.calls,
        ...calls,
      ]

      if (!at) {
        at = found.at
      }
    } else if (calls.length) {
      break
    } else {
      found.results.forEach(id => results.add(id))
    }
  }

  if (!calls.length) {
    return {
      action: null,
      results,
    }
  }

  const latest = calls.slice(-MAX_CALLS)

  return {
    action: {
      calls: latest,
      ...(at ? { at } : {}),
      done: latest.every(call => results.has(call.id)),
    },
    results,
  }
}
