// Types a reply into the terminal a hook session recorded, through the host's own
// CLI: tmux, Herdr or Paseo, or AppleScript for iTerm2 and Terminal. Before
// anything is typed, the session's process must still own its TTY, so text never
// lands in a shell the agent left behind. The text is typed once, then submitted
// with Enter after a short settle; nothing is retried or retyped.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import type { ReplyState } from '../../core/model.ts'
import type { TerminalRoute } from '../../core/route.ts'

const STEP_TIMEOUT_MS = 15_000
const DETAIL_MAX = 300
// Claude Code and Codex open a completion popup for a leading / or $; Enter
// pressed before it settles can pick an entry instead of submitting.
const SETTLE_MS = 400
const POPUP_SETTLE_MS = 1500
// AppleScript error number for "no such session", raised before anything is typed.
const NOT_FOUND = 4404

export interface Delivery {
  state: ReplyState
  detail?: string
}

function sleep({ ms } : { ms: number }): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type RunOptions = { input?: string; env?: NodeJS.ProcessEnv }

function run({ command, args, options = {} } : {
  command: string
  args: string[]
  options?: RunOptions
}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: STEP_TIMEOUT_MS, ...options })
}

function lastLine({ result } : { result: SpawnSyncReturns<string> }): string | undefined {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n')
    .at(-1)
    ?.slice(0, DETAIL_MAX) || undefined
}

// What a failed step means: before the text went in nothing was delivered; once it
// was typed, a failure leaves it unconfirmed, never something to resend.
function outcome(
  { result, command, typed } : {
    result: SpawnSyncReturns<string>
    command: string
    typed: boolean
  },
): Delivery | undefined {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code

  if (code === 'ENOENT') {
    return { state: 'failed', detail: `${command} is not installed or not on PATH` }
  }

  if (result.error && code !== 'ETIMEDOUT') {
    return { state: 'failed', detail: `cannot run ${command}: ${result.error.message}` }
  }

  if (result.status === 0) {
    return undefined
  }

  const line = lastLine({ result })
  const detail = line ? { detail: line } : {}

  return result.status === null || typed ? { state: 'delivery_unknown', ...detail } : { state: 'failed', ...detail }
}

// The session's process still runs on the recorded TTY.
function checkProcess({ route } : { route: TerminalRoute }): Delivery | undefined {
  const result = run({ command: 'ps', args: ['-o', 'tty=', '-p', String(route.pid)] })
  const failed = outcome({ result, command: 'ps', typed: false })

  if (failed && result.status !== 1) {
    return failed
  }

  const tty = (result.stdout ?? '').trim()

  if (!tty) {
    return { state: 'failed', detail: `the session's process ${route.pid} has exited; nothing was typed` }
  }

  if (`/dev/${tty}` !== route.tty) {
    return { state: 'failed', detail: `process ${route.pid} no longer runs on ${route.tty}; nothing was typed` }
  }

  return undefined
}

// A multi-line reply goes in as one bracketed paste, so its newlines do not submit
// early; Claude Code and Codex both read bracketed paste.
function pasted({ text } : { text: string }): string {
  return text.includes('\n') ? `\u001b[200~${text}\u001b[201~` : text
}

function settle({ text } : { text: string }): number {
  return /^[/$]/.test(text) ? POPUP_SETTLE_MS : SETTLE_MS
}

// Two steps, typing then Enter, each through the host's CLI.
function typeThenEnter(
  { command, type, enter, options, text } : {
    command: string
    type: string[]
    enter: string[]
    options: RunOptions
    text: string
  },
): Delivery {
  const typed = outcome({ result: run({ command, args: type, options }), command, typed: false })

  if (typed) {
    return typed
  }

  sleep({ ms: settle({ text }) })

  const submitted = outcome({
    result: run({
      command,
      args: enter,
      options: {
        env: options.env,
      },
    }),
    command,
    typed: true,
  })

  return submitted
    ? { ...submitted, detail: `the text was typed but Enter was not confirmed${submitted.detail ? `: ${submitted.detail}` : ''}; check the session before sending again` }
    : { state: 'delivered' }
}

function tmux({ route, text } : { route: Extract<TerminalRoute, { kind: 'tmux' }>; text: string }): Delivery {
  const sock = ['-S', route.socket]
  const shown = run({ command: 'tmux', args: [...sock, 'display-message', '-p', '-t', route.pane, '#{pane_tty}'] })
  const missing = outcome({ result: shown, command: 'tmux', typed: false })

  if (missing) {
    return missing
  }

  if ((shown.stdout ?? '').trim() !== route.tty) {
    return { state: 'failed', detail: `tmux pane ${route.pane} no longer shows ${route.tty}; nothing was typed` }
  }

  // paste-buffer -p brackets the paste only when the program asked for it.
  const buffer = `pnyx-${process.pid}`
  const loaded = outcome({ result: run({ command: 'tmux', args: [...sock, 'load-buffer', '-b', buffer, '-'], options: { input: text } }), command: 'tmux', typed: false })

  if (loaded) {
    return loaded
  }

  return typeThenEnter({ command: 'tmux', type: [...sock, 'paste-buffer', '-p', '-d', '-b', buffer, '-t', route.pane], enter: [...sock, 'send-keys', '-t', route.pane, 'Enter'], options: {}, text })
}

function paseo({ route, text } : { route: Extract<TerminalRoute, { kind: 'paseo' }>; text: string }): Delivery {
  const home = route.home ? ['--home', route.home] : []

  return typeThenEnter(
    { command: 'paseo', type: ['terminal', 'send-keys', ...home, route.terminal, '-l', '--', pasted({ text })], enter: ['terminal', 'send-keys', ...home, route.terminal, 'Enter'], options: {}, text },
  )
}

function herdr({ route, text } : { route: Extract<TerminalRoute, { kind: 'herdr' }>; text: string }): Delivery {
  const body = pasted({ text })

  // ponytail: herdr's send-text takes the text as a bare argument, so a leading -
  // would read as an option; pass it as a paste if herdr ever needs one.
  if (body.startsWith('-')) {
    return { state: 'failed', detail: 'Herdr cannot take a reply starting with -; nothing was typed' }
  }

  const env = { ...process.env, HERDR_SESSION: route.session }

  return typeThenEnter(
    { command: 'herdr', type: ['pane', 'send-text', route.pane, body, '--session', route.session], enter: ['pane', 'send-keys', route.pane, 'enter', '--session', route.session], options: { env }, text },
  )
}

// Both scripts find the session by TTY and raise NOT_FOUND before typing.
// iTerm2's write text types without a newline, then an empty write sends Enter;
// Terminal's do script types the text and its Return in one go.
const SCRIPTS = {
  'iterm2': `on run argv
  set {theTty, theText, settle} to argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is theTty then
            tell s to write text theText newline false
            delay (settle as number)
            tell s to write text ""
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "no iTerm2 session on " & theTty number ${NOT_FOUND}
end run`,
  'terminal-app': `on run argv
  set {theTty, theText, settle} to argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is theTty then
          do script theText in t
          return
        end if
      end repeat
    end repeat
  end tell
  error "no Terminal tab on " & theTty number ${NOT_FOUND}
end run`,
}

function appleScript({ route, text } : { route: Extract<TerminalRoute, { kind: 'iterm2' | 'terminal-app' }>; text: string }): Delivery {
  const result = run({ command: 'osascript', args: ['-e', SCRIPTS[route.kind], route.tty, pasted({ text }), String(settle({ text }) / 1000)] })
  const failed = outcome({ result, command: 'osascript', typed: true })

  if (!failed) {
    return { state: 'delivered' }
  }

  const err = result.stderr ?? ''

  // -600: the app is not running.
  if (err.includes(`(${NOT_FOUND})`) || err.includes('(-600)')) {
    return { state: 'failed', detail: `${lastLine({ result }) ?? 'session not found'}; nothing was typed` }
  }

  // -1743: macOS has not allowed this program to control the app.
  if (err.includes('(-1743)')) {
    return { state: 'failed', detail: 'macOS has not allowed Pnyx to control this terminal; allow it under System Settings > Privacy & Security > Automation, then send again' }
  }

  return failed
}

export function typeInto({ route, text } : { route: TerminalRoute; text: string }): Delivery {
  const gone = checkProcess({ route })

  if (gone) {
    return gone
  }

  const body = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')

  switch (route.kind) {
    case 'tmux': return tmux({ route, text: body })
    case 'paseo': return paseo({ route, text: body })
    case 'herdr': return herdr({ route, text: body })
    default: return appleScript({ route, text: body })
  }
}
