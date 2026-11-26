import type { Card } from '#tasks/model.ts'
import type { TerminalFacts } from './model.ts'

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
  herdrSession: SAFE,
  herdrPane: SAFE,
}

export function terminalFacts({ value }: { value: unknown }): TerminalFacts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const facts = Object.fromEntries(Object.entries(value).filter(([
    k,
    v,
  ]) =>
    k in TERMINAL_FIELDS
    && typeof v === 'string'
    && TERMINAL_FIELDS[k as keyof TerminalFacts].test(v)))

  return Object.keys(facts).length ? facts : undefined
}

type TerminalHost =
  | {
    kind: 'tmux'
    socket: string
    pane: string
  }
  | {
    kind: 'herdr'
    session: string
    pane: string
  }
  | { kind: 'iterm2' }
  | { kind: 'terminal-app' }

// tty and pid name the harness process that owned the terminal, checked again
// before anything is typed.
export type TerminalRoute = TerminalHost & {
  tty: string
  pid: number
}
export type ReplyRoute = { kind: 'othrys' } | TerminalRoute

export const HOST_LABEL: Record<ReplyRoute['kind'], string> = {
  'tmux': 'tmux',
  'herdr': 'Herdr',
  'othrys': 'Othrys',
  'iterm2': 'iTerm2',
  'terminal-app': 'Terminal',
}

function host({ facts }: { facts: TerminalFacts }): TerminalHost | undefined {
  if (facts.tmux && facts.tmuxPane) {
    return {
      kind: 'tmux',
      socket: facts.tmux,
      pane: facts.tmuxPane,
    }
  }

  if (facts.herdrSession && facts.herdrPane) {
    return {
      kind: 'herdr',
      session: facts.herdrSession,
      pane: facts.herdrPane,
    }
  }

  if (facts.program === 'iTerm.app') {
    return { kind: 'iterm2' }
  }

  if (facts.program === 'Apple_Terminal') {
    return { kind: 'terminal-app' }
  }

  return undefined
}

export function replyRoute({ card }: { card: Card }): { route: ReplyRoute } | { reason: string } {
  if (card.agent?.host === 'othrys' && !card.agent.agentId) {
    return { route: { kind: 'othrys' } }
  }

  if (!card.agent) {
    return { reason: 'This card has no agent session to reply to.' }
  }

  if (card.agent.agentId) {
    return { reason: "A subagent takes input through its parent session's card." }
  }

  if (card.activity === 'ended') {
    return { reason: 'The session ended.' }
  }

  const t = card.terminal

  if (!t) {
    return { reason: 'No terminal is recorded for this session yet. Re-run `othrys setup hooks` to enable typing into sessions; a session then records its terminal when it starts or takes a prompt.' }
  }

  const found = host({ facts: t })

  if (!found) {
    return { reason: `Othrys cannot type into ${t.program ?? 'this terminal'}. Supported: tmux, Herdr, iTerm2 and Terminal.` }
  }

  if (!t.tty || !t.pid) {
    return { reason: "The session's TTY was not found, so typing into its terminal cannot be checked." }
  }

  return {
    route: {
      ...found,
      tty: t.tty,
      pid: Number(t.pid),
    },
  }
}
