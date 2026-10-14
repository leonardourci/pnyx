// Turns one spooled Claude Code or Codex hook payload into card observations.
// Pure: the envelope carries the time, and captured command text is only matched,
// never run.

export const HARNESSES = ['claude', 'codex'] as const
export type Harness = (typeof HARNESSES)[number]

// What pnyx-hook.sh writes: one line per hook call.
export interface HookEnvelope {
  v: 1
  id: string
  at: string
  harness: Harness
  event: string
  payload: unknown
}

export interface Observation {
  // Suffix for the event id, so each observation from one hook call dedupes on its own.
  id: string
  key: string
  card: Record<string, unknown>
  // Only create the card; an existing card is left as it is.
  ifMissing?: boolean
  // A pull request URL seen in a command's output: a refresh hint, not its state.
  link?: string
}

const PROVIDER: Record<Harness, string> = { claude: 'claude-code', codex: 'codex' }
// Shell commands a tool hook reports, counted only in command position. pnyx-hook.sh
// pre-filters on the same list, so a change here goes there too.
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

export function isHookEnvelope(value: Record<string, unknown>): boolean {
  return 'harness' in value
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
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

function activity(event: string, payload: Record<string, unknown>): string | undefined {
  switch (event) {
    case 'SessionStart':
      return str(payload.source) === 'resume' ? 'resumed' : 'started'
    case 'UserPromptSubmit':
      return 'working'
    case 'PreToolUse': {
      const label = commandLabel(payload)

      return label && `running ${label}`
    }
    case 'PostToolUse': {
      const label = commandLabel(payload)

      return label && `ran ${label}`
    }
    case 'Stop':
      return 'idle'
    case 'SubagentStart':
      return 'started'
    case 'SubagentStop':
      return 'stopped'
    case 'SessionEnd':
      return 'ended'
    default:
      return undefined
  }
}

// Returns no observations for a payload without a session id or an event Pnyx does
// not report. A subagent's events go to its own card, keyed under its parent
// session, after making sure the parent card exists.
export function observe(envelope: HookEnvelope): Observation[] {
  const payload = envelope.payload

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return []
  }

  const p = payload as Record<string, unknown>
  const sessionId = str(p.session_id)
  const doing = activity(envelope.event, p)

  if (!sessionId || !doing) {
    return []
  }

  const provider = PROVIDER[envelope.harness]
  const agentId = str(p.agent_id)
  const parentKey = `${envelope.harness}:${sessionId}`
  const source = (objectId: string) => ({ adapter: 'hooks', instanceId: envelope.harness, objectId, observedAt: envelope.at })
  const agent = (extra: Record<string, unknown>) =>
    Object.fromEntries(Object.entries({ provider, sessionId, ...extra, cwd: str(p.cwd) }).filter(([, v]) => v !== undefined))

  const session = {
    source: source(sessionId),
    agent: agent({ transcriptPath: str(p.transcript_path) }),
  }
  const out: Observation[] = []
  let key = parentKey
  let card: Record<string, unknown> = { ...session, activity: doing }

  if (agentId) {
    out.push({ id: 'parent', key: parentKey, card: session, ifMissing: true })
    key = `${parentKey}/${agentId}`
    card = {
      source: source(`${sessionId}/${agentId}`),
      agent: agent({ agentId, agentType: str(p.agent_type), transcriptPath: str(p.agent_transcript_path) }),
      parent: parentKey,
      activity: doing,
    }
  }

  const observation: Observation = { id: '', key, card }

  if (envelope.event === 'PostToolUse' && doing === 'ran gh pr create') {
    const url = PR_URL.exec(JSON.stringify(p.tool_response ?? ''))?.[0]

    if (url) {
      observation.link = url
    }
  }

  out.push(observation)

  return out
}
