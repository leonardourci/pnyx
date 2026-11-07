import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { runProcess, type ProcessResult } from '#app/run-process.ts'
import type { Key } from '#workers/controls.ts'
import { waitsOnHook } from './observe.ts'
import { notificationState, type NotificationResult } from '#workers/inbox-notice.ts'
import type { Card } from '#tasks/model.ts'
import type { ReplyState } from '#workers/model.ts'
import type { TerminalRoute } from '#workers/reply-route.ts'
import type { KeyStep } from './answer.ts'

const STEP_TIMEOUT_MS = 15_000
const DETAIL_MAX = 300
// Claude Code and Codex open a completion popup for a leading / or $; Enter
// pressed before it settles can pick an entry instead of submitting.
export const SETTLE_MS = 400
const POPUP_SETTLE_MS = 1500
const SEQUENCE: Record<Key, string> = {
  'shift-tab': '\u001b[Z',
  'shift-up': '\u001b[1;2A',
  'shift-down': '\u001b[1;2B',
}
const TMUX_KEY: Record<Key | 'enter', string> = {
  'enter': 'Enter',
  'shift-tab': 'BTab',
  'shift-up': 'S-Up',
  'shift-down': 'S-Down',
}
// AppleScript error number for "no such session", raised before anything is typed.
const NOT_FOUND = 4404

export interface Delivery {
  state: ReplyState
  detail?: string
}

const sleep = ({ ms }: { ms: number }) => delay(ms)

type RunOptions = {
  input?: string
  env?: NodeJS.ProcessEnv
}

function run({
  command,
  args,
  options = {},
}: {
  command: string
  args: string[]
  options?: RunOptions
}) {
  return runProcess({
    command,
    args,
    timeout: STEP_TIMEOUT_MS,
    ...options,
  })
}

function lastLine({ result }: { result: ProcessResult }): string | undefined {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n')
    .at(-1)
    ?.slice(
      0,
      DETAIL_MAX,
    ) || undefined
}

// What a failed step means: before the text went in nothing was delivered; once it
// was typed, a failure leaves it unconfirmed, never something to resend.
function outcome(
  {
    result,
    command,
    typed,
  }: {
    result: ProcessResult
    command: string
    typed: boolean
  },
): Delivery | undefined {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code

  if (code === 'ENOENT') {
    return {
      state: 'failed',
      detail: `${command} is not installed or not on PATH`,
    }
  }

  if (result.error && code !== 'ETIMEDOUT') {
    return {
      state: 'failed',
      detail: `cannot run ${command}: ${result.error.message}`,
    }
  }

  if (result.status === 0) {
    return undefined
  }

  const line = lastLine({ result })
  const detail = line ? { detail: line } : {}

  return result.status === null || typed ? {
    state: 'delivery_unknown',
    ...detail,
  } : {
    state: 'failed',
    ...detail,
  }
}

async function checkProcess({ route }: { route: TerminalRoute }): Promise<Delivery | undefined> {
  const result = await run({
    command: 'ps',
    args: [
      '-o',
      'tty=',
      '-p',
      String(route.pid),
    ],
  })
  const failed = outcome({
    result,
    command: 'ps',
    typed: false,
  })

  if (failed && result.status !== 1) {
    return failed
  }

  const tty = (result.stdout ?? '').trim()

  if (!tty) {
    return {
      state: 'failed',
      detail: `the session's process ${route.pid} has exited; nothing was typed`,
    }
  }

  if (`/dev/${tty}` !== route.tty) {
    return {
      state: 'failed',
      detail: `process ${route.pid} no longer runs on ${route.tty}; nothing was typed`,
    }
  }

  return undefined
}

// A multi-line reply goes in as one bracketed paste, so its newlines do not submit
// early; Claude Code and Codex both read bracketed paste.
function pasted({ text }: { text: string }): string {
  return text.includes('\n') ? `\u001b[200~${text}\u001b[201~` : text
}

export function settle({ text }: { text: string }): number {
  return /^[/$]/.test(text) ? POPUP_SETTLE_MS : SETTLE_MS
}

async function typeThenEnter(
  {
    command,
    type,
    enter,
    options,
    text,
  }: {
    command: string
    type: string[]
    enter: string[]
    options: RunOptions
    text: string
  },
): Promise<Delivery> {
  const typed = outcome({
    result: await run({
      command,
      args: type,
      options,
    }),
    command,
    typed: false,
  })

  if (typed) {
    return typed
  }

  await sleep({ ms: settle({ text }) })

  const submitted = outcome({
    result: await run({
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
    ? {
      ...submitted,
      detail: `the text was typed but Enter was not confirmed${submitted.detail ? `: ${submitted.detail}` : ''}; check the session before sending again`,
    }
    : { state: 'delivered' }
}

async function checkPane({ route }: { route: Extract<TerminalRoute, { kind: 'tmux' }> }): Promise<Delivery | undefined> {
  const shown = await run({
    command: 'tmux',
    args: [
      '-S',
      route.socket,
      'display-message',
      '-p',
      '-t',
      route.pane,
      '#{pane_tty}',
    ],
  })
  const missing = outcome({
    result: shown,
    command: 'tmux',
    typed: false,
  })

  if (missing) {
    return missing
  }

  if ((shown.stdout ?? '').trim() !== route.tty) {
    return {
      state: 'failed',
      detail: `tmux pane ${route.pane} no longer shows ${route.tty}; nothing was typed`,
    }
  }

  return undefined
}

// Sends to one pane go one at a time, so two replies' paste and Enter never interleave.
const paneTurns = new Map<string, Promise<void>>()

async function onePerPane({
  key,
  send,
}: {
  key: string
  send(): Promise<Delivery>
}): Promise<Delivery> {
  const previous = paneTurns.get(key)
  let finished = () => {}
  const turn = new Promise<void>(resolve => {
    finished = resolve
  })
  paneTurns.set(
    key,
    turn,
  )

  try {
    await previous

    return await send()
  } finally {
    finished()

    if (paneTurns.get(key) === turn) {
      paneTurns.delete(key)
    }
  }
}

async function tmux({
  route,
  text,
}: {
  route: Extract<TerminalRoute, { kind: 'tmux' }>
  text: string
}): Promise<Delivery> {
  return await onePerPane({
    key: `${route.socket}\n${route.pane}`,
    send: () => tmuxSend({
      route,
      text,
    }),
  })
}

async function tmuxSend({
  route,
  text,
}: {
  route: Extract<TerminalRoute, { kind: 'tmux' }>
  text: string
}): Promise<Delivery> {
  const sock = [
    '-S',
    route.socket,
  ]
  const moved = await checkPane({ route })

  if (moved) {
    return moved
  }

  // Each send loads its own buffer, since sends to other panes of the same tmux server run at once.
  // paste-buffer -p brackets the paste only when the program asked for it.
  const buffer = `pnyx-${process.pid}-${randomUUID()}`
  const loaded = outcome({
    result: await run({
      command: 'tmux',
      args: [
        ...sock,
        'load-buffer',
        '-b',
        buffer,
        '-',
      ],
      options: { input: text },
    }),
    command: 'tmux',
    typed: false,
  })

  if (loaded) {
    return loaded
  }

  const delivery = await typeThenEnter({
    command: 'tmux',
    type: [
      ...sock,
      'paste-buffer',
      '-p',
      '-d',
      '-b',
      buffer,
      '-t',
      route.pane,
    ],
    enter: [
      ...sock,
      'send-keys',
      '-t',
      route.pane,
      'Enter',
    ],
    options: {},
    text,
  })

  // paste-buffer -d removes the buffer once pasted; one left by a failed paste is removed here.
  if (delivery.state === 'failed') {
    await run({
      command: 'tmux',
      args: [
        ...sock,
        'delete-buffer',
        '-b',
        buffer,
      ],
    })
  }

  return delivery
}

async function paseo({
  route,
  text,
}: {
  route: Extract<TerminalRoute, { kind: 'paseo' }>
  text: string
}): Promise<Delivery> {
  const home = route.home ? [
    '--home',
    route.home,
  ] : []

  return typeThenEnter(
    {
      command: 'paseo',
      type: [
        'terminal',
        'send-keys',
        ...home,
        route.terminal,
        '-l',
        '--',
        pasted({ text }),
      ],
      enter: [
        'terminal',
        'send-keys',
        ...home,
        route.terminal,
        'Enter',
      ],
      options: {},
      text,
    },
  )
}

async function herdr({
  route,
  text,
}: {
  route: Extract<TerminalRoute, { kind: 'herdr' }>
  text: string
}): Promise<Delivery> {
  const body = pasted({ text })

  // ponytail: herdr's send-text takes the text as a bare argument, so a leading -
  // would read as an option; pass it as a paste if herdr ever needs one.
  if (body.startsWith('-')) {
    return {
      state: 'failed',
      detail: 'Herdr cannot take a reply starting with -; nothing was typed',
    }
  }

  const env = {
    ...process.env,
    HERDR_SESSION: route.session,
  }

  return typeThenEnter(
    {
      command: 'herdr',
      type: [
        'pane',
        'send-text',
        route.pane,
        body,
        '--session',
        route.session,
      ],
      enter: [
        'pane',
        'send-keys',
        route.pane,
        'enter',
        '--session',
        route.session,
      ],
      options: { env },
      text,
    },
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
  'iterm2-key': `on run argv
  set {theTty, theText} to argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is theTty then
            tell s to write text theText newline false
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

async function appleScript({
  route,
  text,
  key,
}: {
  route: Extract<TerminalRoute, { kind: 'iterm2' | 'terminal-app' }>
  text: string
  key?: Key
}): Promise<Delivery> {
  const result = key
    ? await run({
      command: 'osascript',
      args: [
        '-e',
        SCRIPTS['iterm2-key'],
        route.tty,
        SEQUENCE[key],
      ],
    })
    : await run({
      command: 'osascript',
      args: [
        '-e',
        SCRIPTS[route.kind],
        route.tty,
        pasted({ text }),
        String(settle({ text }) / 1000),
      ],
    })
  const failed = outcome({
    result,
    command: 'osascript',
    typed: true,
  })

  if (!failed) {
    return { state: 'delivered' }
  }

  const err = result.stderr ?? ''

  // -600: the app is not running.
  if (err.includes(`(${NOT_FOUND})`) || err.includes('(-600)')) {
    return {
      state: 'failed',
      detail: `${lastLine({ result }) ?? 'session not found'}; nothing was typed`,
    }
  }

  // -1743: macOS has not allowed this program to control the app.
  if (err.includes('(-1743)')) {
    return {
      state: 'failed',
      detail: 'macOS has not allowed Pnyx to control this terminal; allow it under System Settings > Privacy & Security > Automation, then send again',
    }
  }

  return failed
}

export async function typeInto({
  route,
  text,
}: {
  route: TerminalRoute
  text: string
}): Promise<Delivery> {
  const gone = await checkProcess({ route })

  if (gone) {
    return gone
  }

  const body = text.replace(
    /\r\n?/g,
    '\n',
  ).replace(
    /\n+$/,
    '',
  )

  switch (route.kind) {
    case 'tmux': return await tmux({
      route,
      text: body,
    })
    case 'paseo': return await paseo({
      route,
      text: body,
    })
    case 'herdr': return await herdr({
      route,
      text: body,
    })
    default: return await appleScript({
      route,
      text: body,
    })
  }
}

export async function pressKey({
  route,
  key,
}: {
  route: TerminalRoute
  key: Key | 'enter'
}): Promise<Delivery> {
  const gone = await checkProcess({ route })

  if (gone) {
    return gone
  }

  switch (route.kind) {
    case 'tmux': {
      const moved = await checkPane({ route })

      return moved ?? outcome({
        result: await run({
          command: 'tmux',
          args: [
            '-S',
            route.socket,
            'send-keys',
            '-t',
            route.pane,
            TMUX_KEY[key],
          ],
        }),
        command: 'tmux',
        typed: false,
      }) ?? { state: 'delivered' }
    }
    case 'paseo': {
      const home = route.home ? [
        '--home',
        route.home,
      ] : []
      const keys = key === 'enter' ? ['Enter'] : [
        '-l',
        '--',
        SEQUENCE[key],
      ]

      return outcome({
        result: await run({
          command: 'paseo',
          args: [
            'terminal',
            'send-keys',
            ...home,
            route.terminal,
            ...keys,
          ],
        }),
        command: 'paseo',
        typed: false,
      }) ?? { state: 'delivered' }
    }
    case 'herdr':
      if (key !== 'enter') {
        return {
          state: 'failed',
          detail: 'Pnyx does not press keys other than Enter in Herdr; nothing was sent',
        }
      }

      return outcome({
        result: await run({
          command: 'herdr',
          args: [
            'pane',
            'send-keys',
            route.pane,
            'enter',
            '--session',
            route.session,
          ],
          options: {
            env: {
              ...process.env,
              HERDR_SESSION: route.session,
            },
          },
        }),
        command: 'herdr',
        typed: false,
      }) ?? { state: 'delivered' }
    case 'iterm2':
      return key === 'enter' ? await appleScript({
        route,
        text: '',
      }) : await appleScript({
        route,
        text: '',
        key,
      })
    case 'terminal-app':
      // do script with no text types only its Return.
      return key === 'enter' ? await appleScript({
        route,
        text: '',
      }) : {
        state: 'failed',
        detail: 'Terminal types whole lines, so Pnyx cannot press keys there; nothing was sent',
      }
  }
}

// Types an inline answer into the session's tmux pane, one keystroke chunk at a
// time with its settle after it: typed with send-keys -l, never pasted, since a
// pasted digit would not pick an option. Once a chunk went in, a failure leaves the
// prompt half answered, so it is delivery_unknown and never retyped. Only tmux was
// checked by hand against each harness's prompt.
export async function pressKeys({
  route,
  steps,
}: {
  route: TerminalRoute
  steps: KeyStep[]
}): Promise<Delivery> {
  if (route.kind !== 'tmux') {
    return {
      state: 'failed',
      detail: 'Pnyx answers prompts only in tmux, so answer in the session itself',
    }
  }

  const gone = await checkProcess({ route }) ?? await checkPane({ route })

  if (gone) {
    return gone
  }

  for (const [
    i,
    step,
  ] of steps.entries()) {
    const result = await run({
      command: 'tmux',
      args: [
        '-S',
        route.socket,
        'send-keys',
        '-t',
        route.pane,
        '-l',
        '--',
        step.keys,
      ],
    })
    const failed = outcome({
      result,
      command: 'tmux',
      typed: i > 0,
    })

    if (failed) {
      return i > 0
        ? {
          state: 'delivery_unknown',
          detail: `the answer was typed only in part${failed.detail ? `: ${failed.detail}` : ''}; check the session before answering again`,
        }
        : failed
    }

    await sleep({ ms: step.settleMs })
  }

  return { state: 'delivered' }
}

export async function terminalNotice({
  route,
  text,
  card,
  execute = run,
  send = typeInto,
}: {
  route: TerminalRoute
  text: string
  card: Card
  execute?: typeof run
  send?: typeof typeInto
}): Promise<NotificationResult> {
  const observedProcess = await execute({
    command: 'ps',
    args: [
      '-o',
      'tty=',
      '-p',
      String(route.pid),
    ],
  })

  const processExited = observedProcess.status === 1
    || (observedProcess.status === 0 && !observedProcess.stdout.trim())

  if (processExited) {
    return {
      result: 'gone',
      detail: 'worker process exited; attach a live worker to read the inbox',
    }
  }

  if (observedProcess.status !== 0) {
    return {
      result: 'unknown',
      detail: 'cannot inspect the worker process; nothing was typed',
    }
  }

  if (`/dev/${observedProcess.stdout.trim()}` !== route.tty) {
    return {
      result: 'gone',
      detail: 'worker process moved to another terminal; nothing was typed',
    }
  }

  if (waitsOnHook({ attention: card.attention })) {
    return {
      result: 'deferred',
      detail: 'worker is waiting on a permission or question; answer it before notifying',
    }
  }

  if ((card.sessionActivity ?? card.activity) === 'working') {
    return {
      result: 'deferred',
      detail: 'terminal worker is busy; notification waits for an idle composer',
    }
  }

  if (route.kind !== 'tmux') {
    return {
      result: 'unknown',
      detail: `cannot verify an empty composer on ${route.kind}; read the pending inbox in the worker session`,
    }
  }

  const position = await execute({
    command: 'tmux',
    args: [
      '-S',
      route.socket,
      'display-message',
      '-p',
      '-t',
      route.pane,
      '#{pane_tty}\t#{cursor_y}',
    ],
  })
  const [
    tty,
    cursorRow,
  ] = (position.stdout ?? '').trim().split('\t')

  if (position.status !== 0 || tty !== route.tty || !/^\d+$/.test(cursorRow ?? '')) {
    return {
      result: 'unknown',
      detail: 'cannot verify the tmux pane and cursor; nothing was typed',
    }
  }

  const screen = await execute({
    command: 'tmux',
    args: [
      '-S',
      route.socket,
      'capture-pane',
      '-p',
      '-t',
      route.pane,
    ],
  })
  const lines = (screen.stdout ?? '').split('\n')
  const row = Number(cursorRow)
  const line = lines[row]?.trim()

  if (screen.status !== 0 || !line || !/^[❯›]/u.test(line)) {
    return {
      result: 'unknown',
      detail: 'cannot identify an idle Claude Code or Codex composer; nothing was typed',
    }
  }

  if (!/^[❯›]\s*$/u.test(line)) {
    return {
      result: 'deferred',
      detail: 'the terminal composer contains a draft; clear or submit it before notifying',
    }
  }

  const belowCursor = lines.slice(row + 1)
  const lowerBorder = belowCursor.findIndex(line => /^─{3,}\s*$/u.test(line.trim()))
  const remainingComposer = lowerBorder < 0 ? belowCursor : belowCursor.slice(
    0,
    lowerBorder,
  )

  if (remainingComposer.some(line => line.trim())) {
    return {
      result: 'deferred',
      detail: 'the terminal composer contains multiline text; nothing was typed',
    }
  }

  const delivered = await send({
    route,
    text,
  })

  return {
    result: notificationState({ state: delivered.state }),
    detail: delivered.detail,
  }
}
