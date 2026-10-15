// Turns one spooled Claude Code or Codex hook payload into card observations.
// Pure: the envelope carries the time, and captured command text is only matched,
// never run. Every mapping is a fixed rule on fields the harness sends; nothing
// is classified by a model.
import { basename } from 'node:path'
import type { Attention } from '../../core/model.ts'
import { terminalFacts } from '../../core/route.ts'
import { hookSettings } from './settings.ts'

export const HARNESSES = ['claude', 'codex'] as const
// The events whose hook looks for the session's terminal; any other carries at most its Paseo terminal.
export const TERMINAL_EVENTS = ['SessionStart', 'UserPromptSubmit']
export type Harness = (typeof HARNESSES)[number]

// What pnyx-hook.sh writes: one line per hook call.
export interface HookEnvelope {
  v: 1
  id: string
  at: string
  harness: Harness
  event: string
  // Where the session's terminal is, on SessionStart and UserPromptSubmit.
  terminal?: unknown
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
  // Only create the card; an existing card is left as it is.
  ifMissing?: boolean
  // Only push when the card is missing or attend changes its requests.
  ifChanged?: boolean
  // A pull request URL seen in a command's output: a refresh hint, not its state.
  link?: string
  // "ended" when the session or subagent closed; null when new work reopens it.
  outcome?: 'ended' | null
}

const PROVIDER: Record<Harness, string> = { claude: 'claude-code', codex: 'codex' }
// Shell commands whose output names the pull request they opened.
export const PR_COMMANDS = ['gh pr create', 'gh-axi pr create']
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

// Keys of the requests hooks open, so clearing them never touches another source's.
export const HOOK = 'hook:'
const ELICITATION = `${HOOK}elicitation`
const NOTIFICATION = `${HOOK}notification`

// The one thing Pnyx watches in an agent, as Paseo does: whether it is working on
// a turn, or finished it so its messages are final. "ended" when the session closed.
export type Turn = 'working' | 'finished' | 'ended'

export function isHookEnvelope({ value }: { value: Record<string, unknown> }): boolean {
  return 'harness' in value
}

function str({ value }: { value: unknown }): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

// One line of at most 200 characters, for a request or activity shown on a card.
function short({ value }: { value: string | undefined }): string | undefined {
  const line = value?.replace(/\s+/g, ' ').trim()

  return line && (line.length > 200 ? `${line.slice(0, 199)}…` : line)
}

function commandText({ input }: { input: unknown }): string | undefined {
  const command = (input as { command?: unknown } | null)?.command

  if (!Array.isArray(command)) {
    return str({ value: command })
  }

  // Codex may send argv, such as ["bash", "-lc", "pnpm run deploy"]: the shell's own command string.
  const args = command.filter((c): c is string => typeof c === 'string')
  const flag = args.findIndex(a => /^-[a-z]*c$/.test(a))

  return flag >= 0 ? args[flag + 1] : args.join(' ')
}

// True when a PR command starts the command text or follows &&, ||, ;, | or a newline.
function createsPr({ payload }: { payload: Record<string, unknown> }): boolean {
  return (commandText({ input: payload.tool_input }) ?? '').split(/&&|\|\||[;|\n]/).some(part => {
    const words = part.trim().replace(/\s+/g, ' ')

    return PR_COMMANDS.some(command => words === command || words.startsWith(`${command} `))
  })
}

// The request a tool call puts to the user: its question, a plan to approve, or
// permission to run it with what it would run.
function request(
  { tool, payload, permission }: {
    tool: string
    payload: Record<string, unknown>
    permission: boolean
  },
): Attention | undefined {
  const input = (payload.tool_input ?? {}) as Record<string, unknown>
  const key = `${HOOK}tool:${tool}`

  if (tool === 'AskUserQuestion') {
    const question = (input.questions as { question?: unknown }[] | undefined)?.[0]?.question

    return { kind: 'question', key, blocking: true, text: short({ value: str({ value: question }) }) ?? 'Answer a question' }
  }

  if (tool === 'ExitPlanMode') {
    return { kind: 'plan', key, blocking: true, text: 'Approve the plan' }
  }

  if (!permission) {
    return undefined
  }

  const detail = commandText({ input })
    ?? str({ value: input.file_path })
    ?? str({ value: input.url })
    ?? str({ value: input.description })

  return { kind: 'permission', key, blocking: true, text: short({ value: detail ? `Allow ${tool}: ${detail}` : `Allow ${tool}` }) }
}

// What one hook event does to its card: the turn state it reports, if any, and the
// change to its open requests.
interface Signal {
  activity?: Turn
  attend?: Attend
}

// A tool call that ended or was refused no longer waits on the user.
function toolDone({ tool }: { tool: string }): Attend {
  return { clear: [`${HOOK}tool:${tool}`, NOTIFICATION] }
}

function notification({ payload }: { payload: Record<string, unknown> }): Signal | undefined {
  const message = short({ value: str({ value: payload.message }) })

  switch (str({ value: payload.notification_type })) {
    case 'permission_prompt':
      // PermissionRequest names the tool and command; this repeats it, or covers a
      // prompt that reached the main session from a subagent.
      return { attend: { add: { kind: 'permission', key: NOTIFICATION, blocking: true, text: message ?? 'Permission needed' }, ifNone: true } }
    case 'agent_needs_input':
      return { attend: { add: { kind: 'input', key: NOTIFICATION, blocking: true, text: message ?? 'Input needed' } } }
    case 'elicitation_dialog':
    case 'elicitation_url_dialog':
      return { attend: { add: { kind: 'input', key: ELICITATION, blocking: true, text: message ?? 'Input needed' }, ifNone: true } }
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

// The turn state and the change to the card's requests for one event: a prompt or
// a tool call means the agent is working, and Stop is the harness's own turn end.
// Returns undefined for an event Pnyx does not report.
function signal({ event, payload }: {
  event: string
  payload: Record<string, unknown>
}): Signal | undefined {
  const all = { clear: [HOOK] }
  const tool = str({ value: payload.tool_name }) ?? 'a tool'

  switch (event) {
    case 'SessionStart':
      // A compaction can start a session in the middle of a turn.
      return str({ value: payload.source }) === 'compact' ? { attend: all } : { activity: 'finished', attend: all }
    case 'UserPromptSubmit':
      return { activity: 'working', attend: all }
    case 'PreToolUse':
      return { activity: 'working', attend: { add: request({ tool, payload, permission: false }) } }
    case 'PermissionRequest':
      return { attend: { add: request({ tool, payload, permission: true }) } }
    case 'PermissionDenied':
      return { attend: toolDone({ tool }) }
    case 'PostToolUse':
      return { activity: 'working', attend: toolDone({ tool }) }
    case 'PostToolUseFailure':
      return { activity: payload.is_interrupt === true ? 'finished' : 'working', attend: toolDone({ tool }) }
    case 'Notification':
      return notification({ payload })
    case 'Elicitation': {
      const text = short({ value: [str({ value: payload.mcp_server_name }), str({ value: payload.message })].filter(Boolean).join(': ') })

      return { attend: { add: { kind: 'input', key: ELICITATION, blocking: true, text: text || 'Input needed' } } }
    }
    case 'ElicitationResult':
      return { attend: { clear: [ELICITATION] } }
    case 'Stop':
    case 'StopFailure':
    case 'Interrupt':
    case 'SubagentStop':
      return { activity: 'finished', attend: all }
    case 'SubagentStart':
      return { activity: 'working' }
    case 'SessionEnd':
      return { activity: 'ended', attend: all }
    case 'PostModelSwitch':
      // Only the new model, read by hookSettings; nothing changes in the session's work.
      return {}
    default:
      return undefined
  }
}

// Events that start new work in a session, so an ended session that sends one was resumed.
const REOPENS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart']
const TITLE_MAX = 100

// The prompt's first non-empty line, cut to TITLE_MAX characters.
function promptTitle({ prompt }: { prompt: unknown }): string | undefined {
  const line = str({ value: prompt })?.split('\n')
    .map(l => l.trim())
    .find(l => l !== '')

  return line && line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

// The card's requests after one event's change; pure.
export function attend({ current, change }: { current: Attention[]; change: Attend }): Attention[] {
  const kept = current.filter(a => !change.clear?.some(prefix => a.key.startsWith(prefix)))
  const add = change.add

  if (!add || (change.ifNone && kept.some(a => a.blocking))) {
    return kept
  }

  const others = kept.filter(a => a.key !== add.key)

  // A blocking request goes first: the card shows its first request.
  return add.blocking ? [add, ...others] : [...others, add]
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
  const found = signal({ event: envelope.event, payload: p })

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
      Object.entries({ provider, sessionId, ...extra, cwd })
        .filter(([, v]) => v !== undefined),
    )

  const prompt = envelope.event === 'UserPromptSubmit' ? promptTitle({ prompt: p.prompt }) : undefined
  const folder = cwd && basename(cwd)
  const autoTitle = prompt
    ? { from: 'prompt', text: prompt }
    : folder ? { from: 'folder', text: folder } : undefined
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
    ...session, ...activity, ...(terminal || recordedTerminal ? { terminal: terminal ?? {} } : {}),
  }

  if (agentId) {
    const clears = found.attend?.clear?.some(prefix => NOTIFICATION.startsWith(prefix))
    out.push(clears
      ? { id: 'parent', key: parentKey, card: session, attend: { clear: [NOTIFICATION] }, ifChanged: true }
      : { id: 'parent', key: parentKey, card: session, ifMissing: true })
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
      autoTitle: { from: 'agent', text: `${agentType ?? 'Subagent'} ${agentId.slice(-4)}` },
      parent: parentKey,
      ...activity,
    }
  }

  const settings = hookSettings({ payload: p })

  if (settings) {
    card.settings = settings
  }

  const observation: Observation = { id: '', key, card }

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
