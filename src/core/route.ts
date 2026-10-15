// Chooses the route a reply to a card takes, from facts its sources recorded: a
// Firstmate task replies through Firstmate's send command; any other agent
// session through the terminal its hooks found. Pure: delivery and the live
// checks before it happen in the integrations.
import type { Card, TerminalFacts } from './model.ts'
import { localPaseoUrl } from './paseo.ts'

const SAFE = /^[A-Za-z0-9_.:%,@+=][A-Za-z0-9_./:%,@+=-]{0,255}$/
const PATH = /^\/[A-Za-z0-9_./:%,@+=-]{1,1023}$/

// Accepted shape of each recorded fact. Nothing may start with "-", so no value
// can reach a host's command line as an option.
export const TERMINAL_FIELDS: Record<keyof TerminalFacts, RegExp> = {
  tty: /^\/dev\/(ttys?\d+|pts\/\d+)$/,
  pid: /^[1-9]\d{0,9}$/,
  program: SAFE,
  tmux: PATH,
  tmuxPane: /^%\d+$/,
  paseoTerminal: SAFE,
  paseoHome: PATH,
  herdrSession: SAFE,
  herdrPane: SAFE,
}

// The recorded facts that have the accepted shape; undefined when none do.
export function terminalFacts({ value }: { value: unknown }): TerminalFacts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const facts = Object.fromEntries(Object.entries(value).filter(([k, v]) =>
    k in TERMINAL_FIELDS
    && typeof v === 'string'
    && TERMINAL_FIELDS[k as keyof TerminalFacts].test(v)))

  return Object.keys(facts).length ? facts : undefined
}

export type TerminalHost =
  | { kind: 'tmux'; socket: string; pane: string }
  | { kind: 'herdr'; session: string; pane: string }
  | { kind: 'paseo'; terminal: string; home?: string }
  | { kind: 'iterm2' }
  | { kind: 'terminal-app' }

// tty and pid name the harness process that owned the terminal, checked again
// before anything is typed.
export type TerminalRoute = TerminalHost & { tty: string; pid: number }
export type ReplyRoute = { kind: 'firstmate'; home: string; task: string } | { kind: 'paseo-agent'; agent: string; url: string } | TerminalRoute

export const HOST_LABEL: Record<ReplyRoute['kind'], string> = {
  'firstmate': 'Firstmate',
  'tmux': 'tmux',
  'herdr': 'Herdr',
  'paseo': 'Paseo',
  'paseo-agent': 'Paseo',
  'iterm2': 'iTerm2',
  'terminal-app': 'Terminal',
}

// The innermost host wins: tmux and Herdr run inside a terminal app and inherit
// its variables, and Paseo stamps its own into everything started from it.
// TERM_PROGRAM is set by the terminal emulator itself, and tmux replaces it.
function host({ facts }: { facts: TerminalFacts }): TerminalHost | undefined {
  if (facts.tmux && facts.tmuxPane) {
    return { kind: 'tmux', socket: facts.tmux, pane: facts.tmuxPane }
  }

  if (facts.herdrSession && facts.herdrPane) {
    return { kind: 'herdr', session: facts.herdrSession, pane: facts.herdrPane }
  }

  if (facts.paseoTerminal) {
    return { kind: 'paseo', terminal: facts.paseoTerminal, ...(facts.paseoHome ? { home: facts.paseoHome } : {}) }
  }

  if (facts.program === 'iTerm.app') {
    return { kind: 'iterm2' }
  }

  if (facts.program === 'Apple_Terminal') {
    return { kind: 'terminal-app' }
  }

  return undefined
}

// The route for a reply to this card, or the reason there is none. homes are the
// canonical Firstmate homes configured for replies.
export function replyRoute(
  { card, homes }: { card: Card; homes: string[] },
): { route: ReplyRoute } | { reason: string } {
  const firstmate = card.sourceRefs.find(r => r.adapter === 'firstmate')

  // Firstmate's own send command stays authoritative for its work, so a task card
  // never falls back to typing into the worker's terminal.
  if (firstmate) {
    if (!firstmate.instanceId || firstmate.objectId === '@home') {
      return { reason: 'A Firstmate home takes replies through its task cards.' }
    }

    if (!homes.includes(firstmate.instanceId)) {
      return { reason: `Firstmate home ${firstmate.instanceId} is not configured for replies; start the server with --home ${firstmate.instanceId}.` }
    }

    return { route: { kind: 'firstmate', home: firstmate.instanceId, task: firstmate.objectId } }
  }

  if (!card.agent) {
    return { reason: 'This card has no Firstmate task or agent session to reply to.' }
  }

  if (card.agent.agentId) {
    return { reason: "A subagent takes input through its parent session's card." }
  }

  // A Paseo agent takes messages through its daemon, like Paseo's own composer.
  if (card.agent.paseoAgentId && card.agent.paseoUrl) {
    try {
      return { route: { kind: 'paseo-agent', agent: card.agent.paseoAgentId, url: localPaseoUrl({ url: card.agent.paseoUrl }) } }
    } catch {
      return { reason: 'The recorded Paseo daemon address is not a local one.' }
    }
  }

  if (card.activity === 'ended') {
    return { reason: 'The session ended.' }
  }

  const t = card.terminal

  if (!t) {
    return { reason: 'No terminal is recorded for this session yet. Re-run `pnyx-axi setup hooks` to enable typing into sessions; a session then records its terminal when it starts or takes a prompt.' }
  }

  const found = host({ facts: t })

  if (!found) {
    return { reason: `Pnyx cannot type into ${t.program ?? 'this terminal'}. Supported: tmux, Herdr, Paseo, iTerm2 and Terminal.` }
  }

  if (!t.tty || !t.pid) {
    return { reason: "The session's TTY was not found, so typing into its terminal cannot be checked." }
  }

  return { route: { ...found, tty: t.tty, pid: Number(t.pid) } }
}
