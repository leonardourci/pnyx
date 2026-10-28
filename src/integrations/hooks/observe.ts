import { basename } from 'node:path'
import { MAX_OPTIONS } from '#workers/answers.ts'
import { FORM_FIELD_TYPES, type Attention, type FormField, type Question } from '#workers/model.ts'
import { terminalFacts } from '#workers/reply-route.ts'
import { hookSettings } from './settings.ts'

export const HARNESSES = [
  'claude',
  'codex',
] as const
// The events whose hook looks for the session's terminal; any other carries at most its Paseo terminal.
export const TERMINAL_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
]
export type Harness = (typeof HARNESSES)[number]

export interface HookEnvelope {
  v: 1
  id: string
  at: string
  harness: Harness
  event: string
  terminal?: unknown
  // PNYX_TASK of a session Pnyx started: its task id, or $hydra for the Hydra.
  task?: unknown
  payload: unknown
}

// How one hook event changes the card's open requests, applied to its current ones
// by `attend`: requests whose key starts with a clear prefix are dropped, then add is
// put in, replacing a request with the same key. ifNone adds only while no blocking
// request is open, for a notification that repeats a request already shown.
export interface Attend {
  clear?: string[]
  add?: Attention
  ifNone?: boolean
}

export interface Observation {
  // Suffix for the event id, so each observation from one hook call dedupes on its own.
  id: string
  key: string
  card: Record<string, unknown>
  attend?: Attend
  ifMissing?: boolean
  // Only push when the card is missing or attend changes its requests.
  ifChanged?: boolean
  // A pull request URL seen in a command's output: a refresh hint, not its state.
  link?: string
  // "ended" when the session or subagent closed; null when new work reopens it.
  outcome?: 'ended' | null
}

const PROVIDER: Record<Harness, string> = {
  claude: 'claude-code',
  codex: 'codex',
}
export const PR_COMMANDS = [
  'gh pr create',
  'gh-axi pr create',
]
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

// Keys of the requests hooks open, so clearing them never touches another source's.
export const HOOK = 'hook:'
const ELICITATION = `${HOOK}elicitation`
const NOTIFICATION = `${HOOK}notification`

export type Turn = 'working' | 'finished' | 'ended'

export function isHookEnvelope({ value }: { value: Record<string, unknown> }): boolean {
  return 'harness' in value
}

function str({ value }: { value: unknown }): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function short({ value }: { value: string | undefined }): string | undefined {
  const line = value?.replace(
    /\s+/g,
    ' ',
  ).trim()

  return line && (line.length > 200 ? `${line.slice(
    0,
    199,
  )}…` : line)
}

export function commandText({ input }: { input: unknown }): string | undefined {
  const command = (input as { command?: unknown } | null)?.command

  if (!Array.isArray(command)) {
    return str({ value: command })
  }

  // Codex may send argv, such as ["bash", "-lc", "pnpm run deploy"]: the shell's own command string.
  const args = command.filter((c): c is string => typeof c === 'string')
  const flag = args.findIndex(a => /^-[a-z]*c$/.test(a))

  return flag >= 0 ? args[flag + 1] : args.join(' ')
}

function createsPr({ payload }: { payload: Record<string, unknown> }): boolean {
  return (commandText({ input: payload.tool_input }) ?? '').split(/&&|\|\||[;|\n]/).some(part => {
    const words = part.trim().replace(
      /\s+/g,
      ' ',
    )

    return PR_COMMANDS.some(command => words === command || words.startsWith(`${command} `))
  })
}

// AskUserQuestion's questions with their options, as its prompt shows them; a
// question without a text or options is left out, so it is answered in the terminal.
export function questions({ value }: { value: unknown }): Question[] | undefined {
  const found = (Array.isArray(value) ? value : []).flatMap((item): Question[] => {
    const q = (item ?? {}) as Record<string, unknown>
    const question = str({ value: q.question })
    const options = (Array.isArray(q.options) ? q.options : []).flatMap(o => {
      const option = (o ?? {}) as Record<string, unknown>
      const label = str({ value: option.label })
      const description = str({ value: option.description })

      return label ? [
        {
          label,
          ...(description ? { description } : {}),
        },
      ] : []
    })
    const header = str({ value: q.header })
    const multiSelect = q.multiSelect === true ? { multiSelect: true } : {}

    return question && options.length
      ? [
        {
          question,
          ...(header ? { header } : {}),
          options,
          ...multiSelect,
        },
      ]
      : []
  })

  return Array.isArray(value) && found.length && found.length === value.length ? found : undefined
}

// What the Hydra can fill as the terminal would: anything else (a default, a format,
// titled choices, limits) changes what the prompt shows, so it is left to the terminal.
const FIELD_KEYS = [
  'type',
  'title',
  'description',
  'enum',
]

// An MCP form's fields in the order its prompt lists them; undefined for a URL
// elicitation or a field the Hydra cannot fill, so the form is filled in the terminal.
export function form({ payload }: { payload: Record<string, unknown> }): FormField[] | undefined {
  const schema = (payload.requested_schema ?? {}) as {
    properties?: unknown
    required?: unknown
  }
  type Property = Record<string, unknown> | null
  const properties = Object.entries((schema.properties ?? {}) as Record<string, Property>)
  const required = Array.isArray(schema.required) ? schema.required : []
  const fields = properties.flatMap(([
    name,
    p,
  ]): FormField[] => {
    const type = FORM_FIELD_TYPES.find(t => t === p?.type)
    const options = Array.isArray(p?.enum) && p.enum.every(o => typeof o === 'string') ? p.enum as string[] : undefined
    const title = str({ value: p?.title })

    if (!p || !type
      || Object.keys(p).some(k => !FIELD_KEYS.includes(k))
      || (p.enum !== undefined && (!options || type !== 'string' || options.length > MAX_OPTIONS))) {
      return []
    }

    return [
      {
        name,
        ...(title ? { title } : {}),
        type,
        ...(options ? { options } : {}),
        ...(required.includes(name) ? { required: true } : {}),
      },
    ]
  })

  return str({ value: payload.mode }) !== 'url' && fields.length && fields.length === properties.length ? fields : undefined
}

function request(
  {
    tool,
    payload,
    permission,
  }: {
    tool: string
    payload: Record<string, unknown>
    permission: boolean
  },
): Attention | undefined {
  const input = (payload.tool_input ?? {}) as Record<string, unknown>
  const key = `${HOOK}tool:${tool}`

  if (tool === 'AskUserQuestion') {
    const asked = questions({ value: input.questions })
    const first = (input.questions as { question?: unknown }[] | undefined)?.[0]?.question

    return {
      kind: 'question',
      key,
      blocking: true,
      text: short({ value: str({ value: first }) }) ?? 'Answer a question',
      ...(asked ? { questions: asked } : {}),
    }
  }

  if (tool === 'ExitPlanMode') {
    return {
      kind: 'plan',
      key,
      blocking: true,
      text: 'Approve the plan',
    }
  }

  if (!permission) {
    return undefined
  }

  const detail = commandText({ input })
    ?? str({ value: input.file_path })
    ?? str({ value: input.url })
    ?? str({ value: input.description })

  return {
    kind: 'permission',
    key,
    blocking: true,
    text: short({ value: detail ? `Allow ${tool}: ${detail}` : `Allow ${tool}` }),
  }
}

interface Signal {
  activity?: Turn
  attend?: Attend
}

function toolDone({ tool }: { tool: string }): Attend {
  return {
    clear: [
      `${HOOK}tool:${tool}`,
      NOTIFICATION,
    ],
  }
}

function notification({ payload }: { payload: Record<string, unknown> }): Signal | undefined {
  const message = short({ value: str({ value: payload.message }) })

  switch (str({ value: payload.notification_type })) {
    case 'permission_prompt':
      // PermissionRequest names the tool and command; this repeats it, or covers a
      // prompt that reached the main session from a subagent.
      return {
        attend: {
          add: {
            kind: 'permission',
            key: NOTIFICATION,
            blocking: true,
            text: message ?? 'Permission needed',
          },
          ifNone: true,
        },
      }
    case 'agent_needs_input':
      return {
        attend: {
          add: {
            kind: 'input',
            key: NOTIFICATION,
            blocking: true,
            text: message ?? 'Input needed',
          },
        },
      }
    case 'elicitation_dialog':
    case 'elicitation_url_dialog':
      return {
        attend: {
          add: {
            kind: 'input',
            key: ELICITATION,
            blocking: true,
            text: message ?? 'Input needed',
          },
          ifNone: true,
        },
      }
    case 'elicitation_complete':
    case 'elicitation_response':
      return { attend: { clear: [ELICITATION] } }
    case 'idle_prompt':
      // Claude Code sends no Stop for an interrupted turn; this catches it once the prompt sits idle.
      return { activity: 'finished' }
    default:
      return undefined
  }
}

function signal({
  event,
  payload,
}: {
  event: string
  payload: Record<string, unknown>
}): Signal | undefined {
  const all = { clear: [HOOK] }
  const tool = str({ value: payload.tool_name }) ?? 'a tool'

  switch (event) {
    case 'SessionStart':
      // A compaction can start a session in the middle of a turn.
      return str({ value: payload.source }) === 'compact' ? { attend: all } : {
        activity: 'finished',
        attend: all,
      }
    case 'UserPromptSubmit':
      return {
        activity: 'working',
        attend: all,
      }
    case 'PreToolUse':
      return {
        activity: 'working',
        attend: {
          add: request({
            tool,
            payload,
            permission: false,
          }),
        },
      }
    case 'PermissionRequest':
      return {
        attend: {
          add: request({
            tool,
            payload,
            permission: true,
          }),
        },
      }
    case 'PermissionDenied':
      return { attend: toolDone({ tool }) }
    case 'PostToolUse':
      return {
        activity: 'working',
        attend: toolDone({ tool }),
      }
    case 'PostToolUseFailure':
      return {
        activity: payload.is_interrupt === true ? 'finished' : 'working',
        attend: toolDone({ tool }),
      }
    case 'Notification':
      return notification({ payload })
    case 'Elicitation': {
      const text = short({
        value: [
          str({ value: payload.mcp_server_name }),
          str({ value: payload.message }),
        ].filter(Boolean).join(': '),
      })
      const fields = form({ payload })
      const add: Attention = {
        kind: 'input',
        key: ELICITATION,
        blocking: true,
        text: text || 'Input needed',
      }

      return {
        attend: {
          add: fields ? {
            ...add,
            form: fields,
          } : add,
        },
      }
    }
    case 'ElicitationResult':
      return { attend: { clear: [ELICITATION] } }
    case 'Stop':
    case 'StopFailure':
    case 'Interrupt':
    case 'SubagentStop':
      return {
        activity: 'finished',
        attend: all,
      }
    case 'SubagentStart':
      return { activity: 'working' }
    case 'SessionEnd':
      return {
        activity: 'ended',
        attend: all,
      }
    case 'PostModelSwitch':
    case 'PostCompact':
      // No turn change: the new model is read by hookSettings, and a compaction queues a harvest.
      return {}
    default:
      return undefined
  }
}

const REOPENS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
]
const TITLE_MAX = 100

function promptTitle({ prompt }: { prompt: unknown }): string | undefined {
  const line = str({ value: prompt })?.split('\n')
    .map(l => l.trim())
    .find(l => l !== '')

  return line && line.length > TITLE_MAX ? `${line.slice(
    0,
    TITLE_MAX - 1,
  )}…` : line
}

export function attend({
  current,
  change,
}: {
  current: Attention[]
  change: Attend
}): Attention[] {
  const kept = current.filter(a => !change.clear?.some(prefix => a.key.startsWith(prefix)))
  const add = change.add

  if (!add || (change.ifNone && kept.some(a => a.blocking && !a.answered))) {
    return kept
  }

  const others = kept.filter(a => a.key !== add.key)

  // A blocking request goes first: the card shows its first request.
  return add.blocking ? [
    add,
    ...others,
  ] : [
    ...others,
    add,
  ]
}

// Returns no observations for a payload without a session id or an event Pnyx does
// not report. A subagent's events go to its own card, keyed under its parent
// session, after making sure the parent card exists. A subagent's permission prompt
// notifies on the parent card, so a subagent event that ends its requests also
// clears that notification there.
export function observe({ envelope }: { envelope: HookEnvelope }): Observation[] {
  const payload = envelope.payload

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return []
  }

  const p = payload as Record<string, unknown>
  const sessionId = str({ value: p.session_id })
  const agentId = str({ value: p.agent_id })
  const found = signal({
    event: envelope.event,
    payload: p,
  })

  // Claude Code runs helper agents with an empty agent type (session titles, prompt
  // suggestions, compaction) that its own interface never shows.
  if (!sessionId || !found || (agentId && envelope.harness === 'claude' && p.agent_type === '')) {
    return []
  }

  const provider = PROVIDER[envelope.harness]
  const parentKey = `${envelope.harness}:${sessionId}`
  const source = ({ objectId }: { objectId: string }) => ({
    adapter: 'hooks',
    instanceId: envelope.harness,
    objectId,
    observedAt: envelope.at,
  })
  const cwd = str({ value: p.cwd })
  const agent = ({ extra }: { extra: Record<string, unknown> }) =>
    Object.fromEntries(
      Object.entries({
        provider,
        sessionId,
        ...extra,
        cwd,
      })
        .filter(([
          , v,
        ]) => v !== undefined),
    )

  const prompt = envelope.event === 'UserPromptSubmit' ? promptTitle({ prompt: p.prompt }) : undefined
  const folder = cwd && basename(cwd)
  const autoTitle = prompt
    ? {
      from: 'prompt',
      text: prompt,
    }
    : folder ? {
      from: 'folder',
      text: folder,
    } : undefined
  const session = {
    source: source({ objectId: sessionId }),
    agent: agent({ extra: { transcriptPath: str({ value: p.transcript_path }) } }),
    ...(autoTitle ? { autoTitle } : {}),
  }
  const activity = found.activity ? { activity: found.activity } : {}
  const out: Observation[] = []
  let key = parentKey
  const recordedTerminal = TERMINAL_EVENTS.includes(envelope.event)
  const terminal = recordedTerminal ? terminalFacts({ value: envelope.terminal }) : undefined
  let card: Record<string, unknown> = {
    ...session,
    ...activity,
    ...(terminal || recordedTerminal ? { terminal: terminal ?? {} } : {}),
  }

  if (agentId) {
    const clears = found.attend?.clear?.some(prefix => NOTIFICATION.startsWith(prefix))
    out.push(clears
      ? {
        id: 'parent',
        key: parentKey,
        card: session,
        attend: { clear: [NOTIFICATION] },
        ifChanged: true,
      }
      : {
        id: 'parent',
        key: parentKey,
        card: session,
        ifMissing: true,
      })
    key = `${parentKey}/${agentId}`
    const agentType = str({ value: p.agent_type })
    card = {
      source: source({ objectId: `${sessionId}/${agentId}` }),
      agent: agent({
        extra: {
          agentId,
          agentType,
          transcriptPath: str({ value: p.agent_transcript_path }),
        },
      }),
      autoTitle: {
        from: 'agent',
        text: `${agentType ?? 'Subagent'} ${agentId.slice(-4)}`,
      },
      parent: parentKey,
      ...activity,
    }
  }

  const settings = hookSettings({ payload: p })

  if (settings) {
    card.settings = settings
  }

  const observation: Observation = {
    id: '',
    key,
    card,
  }

  if (envelope.event === 'SessionEnd' || (envelope.event === 'SubagentStop' && agentId)) {
    observation.outcome = 'ended'
  } else if (REOPENS.includes(envelope.event)) {
    observation.outcome = null
  }

  if (found.attend) {
    observation.attend = found.attend
  }

  if (envelope.event === 'PostToolUse' && createsPr({ payload: p })) {
    const url = PR_URL.exec(JSON.stringify(p.tool_response ?? ''))?.[0]

    if (url) {
      observation.link = url
    }
  }

  out.push(observation)

  return out
}
