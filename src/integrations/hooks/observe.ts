// Turns one spooled Claude Code or Codex hook payload into card observations.
// Pure: the envelope carries the time, and captured command text is only matched,
// never run. Every mapping is a fixed rule on fields the harness sends; nothing
// is classified by a model.
import { basename } from 'node:path'
import type { Attention } from '../../core/model.ts'
import { terminalFacts } from '../../core/route.ts'
import { hookSettings } from './settings.ts'

export const HARNESSES = ['claude', 'codex'] as const
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
// Shell commands a tool hook names in its activity, counted only in command position.
export const PR_COMMANDS = ['gh pr create', 'gh pr merge', 'gh-axi pr create', 'gh-axi pr merge']
export const DEPLOY_COMMANDS = [
  'wrangler deploy',
  'railway up',
  'vercel deploy',
  'vercel --prod',
  'netlify deploy',
  'fly deploy',
  'eas update',
  'eas submit',
  'npm run deploy',
  'pnpm run deploy',
  'yarn run deploy',
  'bun run deploy',
]
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

// Keys of the requests hooks open, so clearing them never touches another source's.
export const HOOK = 'hook:'
const ELICITATION = `${HOOK}elicitation`
const NOTIFICATION = `${HOOK}notification`
// Requests that end once the agent is busy again: waiting idle and a failed turn.
const RESUMED = [`${HOOK}idle`, `${HOOK}error`]
// Tools whose call is itself a question to the user, shown in the agent's own prompt.
const ASKING: Record<string, string> = {
  AskUserQuestion: 'asking you a question',
  ExitPlanMode: 'waiting for plan approval',
}

export function isHookEnvelope(value: Record<string, unknown>): boolean {
  return 'harness' in value
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

// One line of at most 200 characters, for a request or activity shown on a card.
function short(value: string | undefined): string | undefined {
  const line = value?.replace(/\s+/g, ' ').trim()

  return line && (line.length > 200 ? `${line.slice(0, 199)}…` : line)
}

function commandText(input: unknown): string | undefined {
  const command = (input as { command?: unknown } | null)?.command

  if (!Array.isArray(command)) {
    return str(command)
  }

  // Codex may send argv, such as ["bash", "-lc", "pnpm run deploy"]: the shell's own command string.
  const args = command.filter((c): c is string => typeof c === 'string')
  const flag = args.findIndex(a => /^-[a-z]*c$/.test(a))

  return flag >= 0 ? args[flag + 1] : args.join(' ')
}

// "gh pr create", "gh pr merge" or "deploy" when a listed command starts the command
// text or follows &&, ||, ;, | or a newline, else undefined.
function commandLabel(payload: Record<string, unknown>): string | undefined {
  for (const part of (commandText(payload.tool_input) ?? '').split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().replace(/\s+/g, ' ')
    const starts = (c: string) => words === c || words.startsWith(`${c} `)
    const pr = PR_COMMANDS.find(starts)

    if (pr) {
      return `gh pr ${pr.split(' ').at(-1)}`
    }

    if (DEPLOY_COMMANDS.some(starts)) {
      return 'deploy'
    }
  }

  return undefined
}

// The request a tool call puts to the user: its question, a plan to approve, or
// permission to run it with what it would run.
function request(
  tool: string,
  payload: Record<string, unknown>,
  permission: boolean,
): Attention | undefined {
  const input = (payload.tool_input ?? {}) as Record<string, unknown>
  const key = `${HOOK}tool:${tool}`

  if (tool === 'AskUserQuestion') {
    const question = (input.questions as { question?: unknown }[] | undefined)?.[0]?.question

    return { kind: 'question', key, blocking: true, text: short(str(question)) ?? 'Answer a question' }
  }

  if (tool === 'ExitPlanMode') {
    return { kind: 'plan', key, blocking: true, text: 'Approve the plan' }
  }

  if (!permission) {
    return undefined
  }

  const detail = commandText(input)
    ?? str(input.file_path) ?? str(input.url) ?? str(input.description)

  return { kind: 'permission', key, blocking: true, text: short(detail ? `Allow ${tool}: ${detail}` : `Allow ${tool}`) }
}

// What one hook event does to its card.
interface Signal {
  activity?: string
  attend?: Attend
}

// A tool call that ended or was refused no longer waits on the user.
function toolDone(tool: string): Attend {
  return { clear: [`${HOOK}tool:${tool}`, NOTIFICATION, ...RESUMED] }
}

function notification(payload: Record<string, unknown>): Signal | undefined {
  const message = short(str(payload.message))

  switch (str(payload.notification_type)) {
    case 'permission_prompt':
      // PermissionRequest names the tool and command; this repeats it, or covers a
      // prompt that reached the main session from a subagent.
      return { attend: { add: { kind: 'permission', key: NOTIFICATION, blocking: true, text: message ?? 'Permission needed' }, ifNone: true } }
    case 'agent_needs_input':
      return { activity: 'needs your input', attend: { add: { kind: 'input', key: NOTIFICATION, blocking: true, text: message ?? 'Input needed' } } }
    case 'elicitation_dialog':
    case 'elicitation_url_dialog':
      return { attend: { add: { kind: 'input', key: ELICITATION, blocking: true, text: message ?? 'Input needed' }, ifNone: true } }
    case 'elicitation_complete':
    case 'elicitation_response':
      return { attend: { clear: [ELICITATION] } }
    case 'idle_prompt':
      return {
        activity: 'idle, waiting for input',
        attend: { add: { kind: 'idle', key: `${HOOK}idle`, blocking: false, text: message ?? 'Waiting for your input' } },
      }
    case 'auth_success':
      return undefined
    default:
      // agent_completed, quota_auto_resume_* and types added later: the agent's own words.
      return message ? { activity: message } : undefined
  }
}

// The card's activity and the change to its requests for one event. Returns
// undefined for an event Pnyx does not report.
function signal(event: string, payload: Record<string, unknown>): Signal | undefined {
  const all = { clear: [HOOK] }
  const tool = str(payload.tool_name) ?? 'a tool'

  switch (event) {
    case 'SessionStart': {
      const source = str(payload.source)

      return { activity: source === 'resume' ? 'resumed' : source === 'compact' ? 'compacted' : 'started', attend: all }
    }
    case 'UserPromptSubmit':
      return { activity: 'working', attend: all }
    case 'PreToolUse': {
      const add = request(tool, payload, false)

      return { activity: ASKING[tool] ?? `running ${commandLabel(payload) ?? tool}`, attend: { clear: RESUMED, add } }
    }
    case 'PermissionRequest':
      return { activity: ASKING[tool] ?? `waiting for permission: ${tool}`, attend: { add: request(tool, payload, true) } }
    case 'PermissionDenied':
      return { activity: `${tool} denied`, attend: toolDone(tool) }
    case 'PostToolUse': {
      const label = commandLabel(payload)

      return { activity: label ? `ran ${label}` : 'working', attend: toolDone(tool) }
    }
    case 'PostToolUseFailure':
      return { activity: payload.is_interrupt === true ? 'interrupted' : `${tool} failed`, attend: toolDone(tool) }
    case 'Notification':
      return notification(payload)
    case 'Elicitation': {
      const text = short([str(payload.mcp_server_name), str(payload.message)].filter(Boolean).join(': '))

      return { activity: 'waiting for your input', attend: { add: { kind: 'input', key: ELICITATION, blocking: true, text: text || 'Input needed' } } }
    }
    case 'ElicitationResult':
      return { activity: 'working', attend: { clear: [ELICITATION] } }
    case 'Stop': {
      const running = Array.isArray(payload.background_tasks)
        ? payload.background_tasks.filter(t => (t as { status?: unknown } | null)?.status === 'running').length
        : 0

      return { activity: running ? `idle, ${running} background task${running > 1 ? 's' : ''} running` : 'idle', attend: all }
    }
    case 'StopFailure': {
      const error = str(payload.error) ?? 'unknown'
      const text = short([error, str(payload.error_details)].filter(Boolean).join(': '))!

      return { activity: `stopped on ${error}`, attend: { clear: [HOOK], add: { kind: 'error', key: `${HOOK}error`, blocking: false, text } } }
    }
    case 'Interrupt':
      return { activity: 'interrupted', attend: all }
    case 'SubagentStart':
      return { activity: 'started' }
    case 'SubagentStop':
      return { activity: 'stopped', attend: all }
    case 'TaskCreated':
    case 'TaskCompleted': {
      const subject = str(payload.task_subject) ?? str(payload.task_id) ?? 'a task'

      return { activity: short(`${event === 'TaskCreated' ? 'task' : 'task done'}: ${subject}`) }
    }
    case 'TeammateIdle':
      return { activity: short(`teammate ${str(payload.teammate_name) ?? str(payload.agent_id) ?? ''} idle`) }
    case 'PreCompact':
      return { activity: 'compacting' }
    case 'PostCompact':
      return { activity: 'compacted' }
    case 'SessionEnd':
      return { activity: 'ended', attend: all }
    default:
      return undefined
  }
}

// Events that start new work in a session, so an ended session that sends one was resumed.
const REOPENS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart']
const TITLE_MAX = 100

// The prompt's first non-empty line, cut to TITLE_MAX characters.
function promptTitle(prompt: unknown): string | undefined {
  const line = str(prompt)?.split('\n')
    .map(l => l.trim())
    .find(l => l !== '')

  return line && line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

// The card's requests after one event's change; pure.
export function attend(current: Attention[], change: Attend): Attention[] {
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
export function observe(envelope: HookEnvelope): Observation[] {
  const payload = envelope.payload

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return []
  }

  const p = payload as Record<string, unknown>
  const sessionId = str(p.session_id)
  const agentId = str(p.agent_id)
  const found = signal(envelope.event, p)

  if (!sessionId || !found) {
    return []
  }

  const provider = PROVIDER[envelope.harness]
  const parentKey = `${envelope.harness}:${sessionId}`
  const source = (objectId: string) => ({
    adapter: 'hooks',
    instanceId: envelope.harness,
    objectId,
    observedAt: envelope.at,
  })
  const cwd = str(p.cwd)
  const agent = (extra: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries({ provider, sessionId, ...extra, cwd })
        .filter(([, v]) => v !== undefined),
    )

  const prompt = envelope.event === 'UserPromptSubmit' ? promptTitle(p.prompt) : undefined
  const folder = cwd && basename(cwd)
  const autoTitle = prompt
    ? { from: 'prompt', text: prompt }
    : folder ? { from: 'folder', text: folder } : undefined
  const session = {
    source: source(sessionId),
    agent: agent({ transcriptPath: str(p.transcript_path) }),
    ...(autoTitle ? { autoTitle } : {}),
  }
  const activity = found.activity ? { activity: found.activity } : {}
  const out: Observation[] = []
  let key = parentKey
  const terminal = terminalFacts(envelope.terminal)
  const recordedTerminal = ['SessionStart', 'UserPromptSubmit'].includes(envelope.event)
  let card: Record<string, unknown> = {
    ...session, ...activity, ...(terminal || recordedTerminal ? { terminal: terminal ?? {} } : {}),
  }

  if (agentId) {
    const clears = found.attend?.clear?.some(prefix => NOTIFICATION.startsWith(prefix))
    out.push(clears
      ? { id: 'parent', key: parentKey, card: session, attend: { clear: [NOTIFICATION] }, ifChanged: true }
      : { id: 'parent', key: parentKey, card: session, ifMissing: true })
    key = `${parentKey}/${agentId}`
    const agentType = str(p.agent_type)
    card = {
      source: source(`${sessionId}/${agentId}`),
      agent: agent({
        agentId,
        agentType,
        transcriptPath: str(p.agent_transcript_path),
      }),
      autoTitle: { from: 'agent', text: `${agentType ?? 'Subagent'} ${agentId.slice(-4)}` },
      parent: parentKey,
      ...activity,
    }
  }

  const settings = hookSettings(p)

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

  if (envelope.event === 'PostToolUse' && found.activity === 'ran gh pr create') {
    const url = PR_URL.exec(JSON.stringify(p.tool_response ?? ''))?.[0]

    if (url) {
      observation.link = url
    }
  }

  out.push(observation)

  return out
}
