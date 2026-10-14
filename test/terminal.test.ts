// Typing replies into a hook session's terminal. Every host (tmux, Paseo, Herdr,
// osascript) and ps is the fake in test/fixtures/hosts on PATH: tests never type
// into a real session.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { Card } from '../src/core/model.ts'
import { confirms, findOption, inputReason } from '../src/core/control.ts'
import { replyRoute, terminalFacts } from '../src/core/route.ts'
import { loadBoard } from '../src/store/board-store.ts'

const ROOT = join(import.meta.dirname, '..')
const BIN = join(ROOT, 'dist', 'cli', 'pnyx-axi.js')
const HOST = join(ROOT, 'test', 'fixtures', 'hosts', 'host.sh')
const TTY = '/dev/ttys042'

function hosts() {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-t-'))
  const bin = join(root, 'bin')
  const stub = join(root, 'stub')
  mkdirSync(bin)
  mkdirSync(stub)

  for (const name of ['tmux', 'paseo', 'herdr', 'osascript', 'ps']) {
    symlinkSync(HOST, join(bin, name))
  }

  // ps answers that the session's process still runs on its TTY.
  writeFileSync(join(stub, 'ps.out'), 'ttys042\n')
  const env = { ...process.env, PNYX_HOME: join(root, 'pnyx'), STUB_DIR: stub, PATH: `${bin}:/usr/bin:/bin` }
  const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })

  const fails = (args: string[], code: string) => {
    try {
      run(...args)
    } catch (error) {
      assert.match(String((error as { stdout?: string }).stdout), new RegExp(`code: ${code}`))

      return
    }

    assert.fail(`expected ${code}`)
  }

  const calls = () => {
    const log = join(stub, 'calls.log')

    return existsSync(log) ? readFileSync(log, 'utf8').split('---\n')
      .filter(Boolean) : []
  }

  const set = (file: string, text: string) => writeFileSync(join(stub, file), text)

  const session = (key: string, terminal: Record<string, string>) => {
    const file = join(root, `${key}.json`)
    writeFileSync(file, JSON.stringify({ agent: { provider: 'claude-code', sessionId: key }, terminal: { tty: TTY, pid: '4242', ...terminal } }))
    run('push', '--key', key, '--file', file)
  }

  return { root, env, run, fails, calls, set, session }
}

const card = (fields: Partial<Card>): Card => ({
  id: 'c1',
  key: 'k',
  title: 'k',
  workspace: 'unassigned',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  column: 'workers_on_it',
  revision: 1,
  createdSeq: 1,
  updatedSeq: 1,
  updatedAt: '2026-10-14T00:00:00Z',
  agent: { provider: 'claude-code', sessionId: 's' },
  ...fields,
})

const reason = (c: Card) => {
  const r = replyRoute({ card: c, homes: [] })

  return 'reason' in r ? r.reason : r.route.kind
}

test('the innermost recorded host is the route', () => {
  const base = { tty: TTY, pid: '9' }
  assert.equal(reason(card({ terminal: { ...base, program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3', paseoTerminal: 'p1' } })), 'tmux')
  assert.equal(reason(card({ terminal: { ...base, program: 'kitty', paseoTerminal: 'p1', herdrSession: 'h', herdrPane: 'p2' } })), 'herdr')
  assert.equal(reason(card({ terminal: { ...base, program: 'kitty', paseoTerminal: 'p1' } })), 'paseo')
  assert.equal(reason(card({ terminal: { ...base, program: 'iTerm.app' } })), 'iterm2')
  assert.equal(reason(card({ terminal: { ...base, program: 'Apple_Terminal' } })), 'terminal-app')
  assert.match(reason(card({ terminal: { ...base, program: 'vscode' } })), /cannot type into vscode/)
  assert.match(reason(card({ terminal: { program: 'tmux', tmux: '/tmp/s', tmuxPane: '%1' } })), /TTY was not found/)
  assert.match(reason(card({})), /No terminal is recorded/)
  assert.match(reason(card({ activity: 'ended', terminal: { ...base, program: 'Apple_Terminal' } })), /session ended/)
  assert.match(reason(card({ agent: { provider: 'claude-code', sessionId: 's', agentId: 'a' } })), /subagent/)
  assert.match(reason(card({ agent: undefined })), /no Firstmate task or agent session/)
  // A Firstmate task keeps its own send command, even with a terminal recorded.
  const fm = card({ sourceRefs: [{ adapter: 'firstmate', instanceId: '/fm', objectId: 'task' }], terminal: { ...base, program: 'Apple_Terminal' } })
  assert.match(reason(fm), /not configured/)
  assert.deepEqual(replyRoute({ card: fm, homes: ['/fm'] }), { route: { kind: 'firstmate', home: '/fm', task: 'task' } })
  // Values that could reach a command line as options or quotes are dropped.
  assert.deepEqual(terminalFacts({ value: { tty: TTY, tmuxPane: '-t', program: 'a b', pid: '0', paseoTerminal: '--x', extra: 'y' } }), { tty: TTY })
})

test('a tmux reply checks the pane, pastes once and presses Enter', () => {
  const { run, calls, set, session, fails } = hosts()
  session('s1', { program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3' })
  set('tmux.out.1', `${TTY}\n`)
  const out = run('reply', 's1', '--text', 'first line\nsecond line', '--idempotency-key', 'k1')
  assert.match(out, /state: delivered/)
  const log = calls()
  assert.deepEqual(log.map(c => c.split('\n')[0]), ['call=ps', 'call=tmux', 'call=tmux', 'call=tmux', 'call=tmux'])
  assert.match(log[0]!, /arg=-p\narg=4242/)
  assert.match(log[1]!, /arg=-S\narg=\/tmp\/tmux-1\/default\narg=display-message\narg=-p\narg=-t\narg=%3\narg=#\{pane_tty\}/)
  assert.match(log[2]!, /arg=load-buffer[\s\S]*stdin=first line\nsecond line/)
  assert.match(log[3]!, /arg=paste-buffer\narg=-p\narg=-d[\s\S]*arg=-t\narg=%3/)
  assert.match(log[4]!, /arg=send-keys\narg=-t\narg=%3\narg=Enter\n$/)
  // The same key never sends twice.
  assert.match(run('reply', 's1', '--text', 'first line\nsecond line', '--idempotency-key', 'k1'), /sent: false/)
  assert.equal(calls().length, 5)
  assert.match(run('history', '--card', 's1', '--kind', 'replied'), /reply k1 delivered/)
  fails(['reply', 's1', '--text', 'x', '--resolve-key', 'k'], 'VALIDATION_ERROR')
})

test('a changed pane or an exited process types nothing', () => {
  const { run, calls, set, session } = hosts()
  session('s1', { program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3' })
  set('tmux.out', '/dev/ttys099\n')
  assert.match(run('reply', 's1', '--text', 'hi'), /state: failed\n {2}detail: tmux pane %3 no longer shows \/dev\/ttys042; nothing was typed/)
  assert.equal(calls().filter(c => /load-buffer|paste-buffer|send-keys/.test(c)).length, 0)

  set('ps.out', '')
  set('ps.exit', '1')
  assert.match(run('reply', 's1', '--text', 'hi'), /detail: the session's process 4242 has exited; nothing was typed/)
  set('ps.exit', '0')
  set('ps.out', 'ttys007\n')
  assert.match(run('reply', 's1', '--text', 'hi'), /detail: process 4242 no longer runs on \/dev\/ttys042/)
  assert.equal(calls().filter(c => c.startsWith('call=tmux')).length, 1)
})

test('a Paseo reply types literally, then submits; a lost Enter is never resent', () => {
  const { run, calls, set, session } = hosts()
  session('s1', { program: 'kitty', paseoTerminal: 'term-1', paseoHome: '/tmp/paseo' })
  assert.match(run('reply', 's1', '--text', 'one\ntwo', '--idempotency-key', 'k1'), /state: delivered/)
  const [, typed, enter] = calls()
  assert.ok(typed!.endsWith('arg=terminal\narg=send-keys\narg=--home\narg=/tmp/paseo\narg=term-1\narg=-l\narg=--\narg=\u001b[200~one\ntwo\u001b[201~\n'))
  assert.match(enter!, /arg=term-1\narg=Enter\n$/)

  set('paseo.exit.4', '1')
  set('paseo.err', 'daemon unreachable')
  const unknown = run('reply', 's1', '--text', '/review', '--idempotency-key', 'k2')
  assert.match(unknown, /state: delivery_unknown/)
  assert.match(unknown, /the text was typed but Enter was not confirmed: daemon unreachable/)
  assert.match(run('reply', 's1', '--text', '/review', '--idempotency-key', 'k2'), /sent: false/)
  assert.equal(calls().length, 6)
})

test('a Herdr reply names its session and pane', () => {
  const { run, calls, session } = hosts()
  session('s1', { program: 'ghostty', herdrSession: 'work', herdrPane: 'p_7' })
  assert.match(run('reply', 's1', '--text', 'go'), /state: delivered/)
  const [, typed, enter] = calls()
  assert.match(typed!, /arg=pane\narg=send-text\narg=p_7\narg=go\narg=--session\narg=work\n$/)
  assert.match(enter!, /arg=pane\narg=send-keys\narg=p_7\narg=enter\narg=--session\narg=work\n$/)
})

test('iTerm2 and Terminal get the text and TTY as AppleScript arguments', () => {
  const { run, calls, set, session } = hosts()
  session('s1', { program: 'iTerm.app' })
  session('s2', { program: 'Apple_Terminal' })
  assert.match(run('reply', 's1', '--text', 'say "hi"'), /state: delivered/)
  const iterm = calls()[1]!
  assert.match(iterm, /tell application "iTerm2"[\s\S]*end run\narg=\/dev\/ttys042\narg=say "hi"\narg=0.4\n$/)
  assert.match(run('reply', 's2', '--text', 'hello'), /state: delivered/)
  assert.match(calls()[3]!, /tell application "Terminal"/)

  set('osascript.exit', '1')
  set('osascript.err', 'execution error: no Terminal tab on /dev/ttys042 (4404)')
  assert.match(run('reply', 's2', '--text', 'hello'), /state: failed[\s\S]*nothing was typed/)
  set('osascript.err', 'execution error: Not authorized to send Apple events to Terminal. (-1743)')
  assert.match(run('reply', 's2', '--text', 'hello'), /state: failed[\s\S]*Privacy & Security > Automation/)
  set('osascript.err', 'execution error: something else (-2700)')
  assert.match(run('reply', 's2', '--text', 'hello'), /state: delivery_unknown/)
})

test('a card with no route says why', () => {
  const { root, run, fails, session } = hosts()
  session('s1', { program: 'vscode' })
  fails(['reply', 's1', '--text', 'x'], 'NO_ROUTE')
  writeFileSync(join(root, 'plain.json'), '{"title":"plain"}')
  run('push', '--key', 'plain', '--file', join(root, 'plain.json'))
  fails(['reply', 'plain', '--text', 'x'], 'NO_ROUTE')
})

const execFileAsync = promisify(execFile)

test('the hook records the terminal the session runs in, past wrapper shells, and none for a headless run', async () => {
  const { root, env } = hosts()
  const home = join(root, 'pnyx')
  const script = join(home, 'hooks', 'pnyx-hook.sh')
  mkdirSync(join(home, 'hooks'), { recursive: true })
  copyFileSync(join(ROOT, 'setup', 'hooks', 'pnyx-hook.sh'), script)
  writeFileSync(join(env.STUB_DIR, 'ps.out.1'), '777 ttys042 -zsh\n')
  writeFileSync(join(env.STUB_DIR, 'ps.out.2'), '1 ttys042 /usr/local/bin/claude\n')
  const hostEnv = {
    PATH: env.PATH,
    STUB_DIR: env.STUB_DIR,
    TERM_PROGRAM: 'tmux',
    TMUX: '/tmp/tmux-501/default,123,0',
    TMUX_PANE: '%5',
    PASEO_TERMINAL_ID: 'term-1',
    PASEO_ACTIVITY_TOKEN: 'secret',
  }
  const child = execFileAsync('/bin/sh', [script, 'claude', 'SessionStart'], { encoding: 'utf8', env: hostEnv })
  child.child.stdin!.end('{"session_id":"s1","cwd":"/work"}')
  const { stdout, stderr } = await child
  assert.equal(stdout + stderr, '')
  const spool = join(home, 'boards', 'default', 'spool')
  const line = JSON.parse(readFileSync(join(spool, readdirSync(spool)[0]!), 'utf8'))
  assert.deepEqual(line.terminal, {
    tty: TTY,
    pid: '777',
    program: 'tmux',
    tmux: '/tmp/tmux-501/default',
    tmuxPane: '%5',
    paseoTerminal: 'term-1',
  })
  assert.doesNotMatch(JSON.stringify(line), /secret/)

  // Ingesting the spool puts the facts on the session's card.
  execFileSync(process.execPath, [BIN, 'harvest'], { env: { ...env, PNYX_HOME: home }, encoding: 'utf8' })
  process.env.PNYX_HOME = home
  const { state } = loadBoard({ board: 'default' })
  assert.deepEqual(state.cards[state.keys['claude:s1']!]!.terminal, line.terminal)

  // A headless harness that session started records no tty or pid of its own.
  writeFileSync(join(env.STUB_DIR, 'ps.out.3'), '888 ?? zsh\n')
  writeFileSync(join(env.STUB_DIR, 'ps.out.4'), '777 ?? /usr/local/bin/claude\n')
  writeFileSync(join(env.STUB_DIR, 'ps.out.5'), '1 ttys042 /usr/local/bin/claude\n')
  const headless = execFileAsync('/bin/sh', [script, 'claude', 'SessionStart'], { encoding: 'utf8', env: hostEnv })
  headless.child.stdin!.end('{"session_id":"s2","cwd":"/work"}')
  await headless
  const [file] = readdirSync(spool).filter(f => f.endsWith('.json'))
  assert.deepEqual(JSON.parse(readFileSync(join(spool, file!), 'utf8')).terminal, {
    program: 'tmux',
    tmux: '/tmp/tmux-501/default',
    tmuxPane: '%5',
    paseoTerminal: 'term-1',
  })

  // Any other event records only the Paseo terminal, and leaves the card's facts alone.
  const tool = execFileAsync('/bin/sh', [script, 'claude', 'PreToolUse'], { encoding: 'utf8', env: hostEnv })
  tool.child.stdin!.end('{"session_id":"s1","cwd":"/work","tool_name":"Bash","tool_input":{"command":"ls"}}')
  await tool
  const lines = readdirSync(spool).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(spool, f), 'utf8')) as { event: string; terminal?: object })
  assert.deepEqual(lines.find(l => l.event === 'PreToolUse')?.terminal, { paseoTerminal: 'term-1' })
  execFileSync(process.execPath, [BIN, 'harvest'], { env: { ...env, PNYX_HOME: home }, encoding: 'utf8' })
  const after = loadBoard({ board: 'default' }).state
  assert.deepEqual(after.cards[after.keys['claude:s1']!]!.terminal, line.terminal)
})

test('agent types a Claude Code command, answers its confirmation and presses keys where the host can', () => {
  const { run, calls, set, session, fails } = hosts()
  session('s1', { program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3' })
  set('tmux.out', `${TTY}\n`)
  assert.match(run('agent', 's1'), /harness: claude-code[\s\S]*route: "terminal:tmux"[\s\S]*mode,unknown,next,yes/)

  const effort = run('agent', 's1', 'effort', 'high', '--idempotency-key', 'e1')
  assert.match(effort, /sent: delivered/)
  // Not reported back yet: Claude Code reports effort on its next turn.
  assert.match(effort, /confirmed: false[\s\S]*next hook or turn/)
  const keys = calls().map(c => c.split('\n')[0])
  assert.deepEqual(keys, ['call=ps', 'call=tmux', 'call=tmux', 'call=tmux', 'call=tmux', 'call=ps', 'call=tmux', 'call=tmux'])
  assert.match(calls()[2]!, /stdin=\/effort high/)
  // The command is submitted, then one more Enter answers a confirmation if one shows.
  assert.match(calls()[4]!, /arg=send-keys\narg=-t\narg=%3\narg=Enter\n$/)
  assert.match(calls()[7]!, /arg=send-keys\narg=-t\narg=%3\narg=Enter\n$/)
  assert.match(run('history', '--card', 's1', '--kind', 'replied'), /reply e1 delivered/)

  assert.match(run('agent', 's1', 'mode', 'next'), /sent: delivered/)
  assert.match(calls().at(-1)!, /arg=send-keys\narg=-t\narg=%3\narg=BTab\n$/)
  assert.equal(calls().filter(c => c.includes('load-buffer')).length, 1)

  fails(['agent', 's1', 'model', 'gpt-6'], 'VALIDATION_ERROR')
  fails(['agent', 's1', 'collaboration', 'toggle'], 'VALIDATION_ERROR')
  fails(['agent', 's1', 'model'], 'VALIDATION_ERROR')
})

test('agent reads a Codex change back from the transcript at once', () => {
  const { root, run, calls, set, fails } = hosts()
  const transcript = join(root, 'rollout.jsonl')
  writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { originator: 'codex_cli_rs' } })}\n`)
  const file = join(root, 'codex.json')
  writeFileSync(file, JSON.stringify({
    agent: { provider: 'codex', sessionId: 'x1', transcriptPath: transcript },
    settings: { effort: 'medium' },
    terminal: { tty: TTY, pid: '4242', program: 'kitty', paseoTerminal: 'term-1' },
  }))
  run('push', '--key', 'x1', '--file', file)
  fails(['agent', 'x1', 'model', 'gpt-6.1-sol'], 'VALIDATION_ERROR')
  fails(['agent', 'x1', 'approval', 'on-request'], 'VALIDATION_ERROR')
  assert.match(run('agent', 'x1'), /harness: codex[\s\S]*picks its model and approval mode only[\s\S]*effort,medium,lower raise,yes/)

  // The fake host stands in for Codex: the change lands in its rollout as it is sent.
  const applied = { timestamp: '2026-10-14T16:06:00Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { reasoning_effort: 'high', service_tier: 'default' } } }
  set('append.path', transcript)
  set('paseo.append.1', `${JSON.stringify(applied)}\n`)
  const out = run('agent', 'x1', 'effort', 'raise')
  assert.match(out, /sent: delivered\n {2}before: medium\n {2}now: high\n {2}confirmed: true/)
  assert.ok(calls().at(-1)!.endsWith('arg=terminal\narg=send-keys\narg=term-1\narg=-l\narg=--\narg=\u001b[1;2A\n'))
  assert.match(run('agent', 'x1', 'collaboration', 'toggle'), /sent: delivered/)
  assert.ok(calls().at(-1)!.endsWith('arg=-l\narg=--\narg=\u001b[Z\n'))
})

test('iTerm2 gets a key as raw bytes; Terminal and Herdr refuse keys before sending', () => {
  const { run, calls, session, fails } = hosts()
  session('s1', { program: 'iTerm.app' })
  assert.match(run('agent', 's1', 'mode', 'next'), /sent: delivered/)
  const key = calls().at(-1)!
  assert.match(key, /tell application "iTerm2"[\s\S]*newline false[\s\S]*end run\narg=\/dev\/ttys042\n/)
  assert.ok(key.endsWith('arg=\u001b[Z\n'))

  const before = calls().length
  session('s2', { program: 'Apple_Terminal' })
  session('s3', { program: 'ghostty', herdrSession: 'work', herdrPane: 'p_7' })
  fails(['agent', 's2', 'mode', 'next'], 'NO_ROUTE')
  fails(['agent', 's3', 'mode', 'next'], 'NO_ROUTE')
  assert.match(run('agent', 's2'), /mode,unknown,next,"Terminal types whole lines/)
  assert.equal(calls().length, before)
  // Typed commands still go everywhere a reply goes.
  assert.match(run('agent', 's2', 'fast', 'off'), /sent: delivered/)
  assert.match(calls().at(-1)!, /tell application "Terminal"[\s\S]*arg=\/fast off\n/)
})

test("a session's report confirms a change the way its control reads back", () => {
  const check = (
    provider: string,
    setting: string,
    value: string,
    before?: string,
    after?: string,
  ) =>
    confirms({ ...findOption({ provider, setting, value })!, before, after })

  // A model alias confirms on the full id the session reports.
  assert.equal(check('claude-code', 'model', 'opus', 'claude-sonnet-5-5', 'claude-opus-5-5'), true)
  assert.equal(check('claude-code', 'model', 'opus', 'claude-sonnet-5-5', 'claude-sonnet-5-5'), false)
  assert.equal(check('claude-code', 'effort', 'high', 'medium', 'high'), true)
  assert.equal(check('claude-code', 'effort', 'xhigh', 'medium', 'high'), false)
  // A key that cycles or steps confirms on any change.
  assert.equal(check('claude-code', 'mode', 'next', 'auto', 'default'), true)
  assert.equal(check('codex', 'effort', 'raise', 'medium', 'medium'), false)
  assert.equal(check('codex', 'fast', 'toggle', 'off', undefined), false)
  assert.equal(findOption({ provider: 'codex', setting: 'model', value: 'gpt-6' }), undefined)

  for (const [setting, value] of [['model', 'gpt-6.1-sol'], ['approval', 'on-request']]) {
    assert.equal(findOption({ provider: 'codex', setting: setting!, value: value! }), undefined)
    const picked = findOption({ provider: 'codex', setting: setting!, value: value!, firstmate: true })
    assert.ok(picked, `${setting} must be requestable on a Firstmate Codex card`)
    assert.deepEqual(picked.option.input, { request: true })
    assert.equal(inputReason({ kind: 'firstmate', input: picked.option.input }), undefined)
    assert.match(inputReason({ kind: 'tmux', input: picked.option.input })!, /only be requested through Firstmate/)
    assert.equal(confirms({ ...picked, before: undefined, after: value }), true)
    assert.equal(confirms({ ...picked, before: 'old', after: 'different' }), false)
  }

  assert.equal(findOption({ provider: 'opencode', setting: 'effort', value: 'high' }), undefined)
})

test('a setting change waits for an open request and never answers one the session opens meanwhile', () => {
  const { run, calls, set, session, fails } = hosts()
  session('claude:s1', { program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3' })
  set('tmux.out', `${TTY}\n`)
  const hook = (event: string, payload: Record<string, unknown>) => JSON.stringify({ v: 1, id: `h-${event}`, at: '2026-10-14T17:00:00Z', harness: 'claude', event, payload: { session_id: 's1', cwd: '/work', ...payload } })

  // A permission prompt shows up while the command settles: no confirming Enter.
  set('tmux.spool.4', hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }))
  const out = run('agent', 'claude:s1', 'model', 'opus')
  assert.match(out, /sent: delivery_unknown/)
  assert.match(out, /the session opened a request, so Pnyx pressed nothing more/)
  assert.deepEqual(calls().map(c => c.split('\n')[0]), ['call=ps', 'call=tmux', 'call=tmux', 'call=tmux', 'call=tmux'])

  // While it stays open, nothing is typed for a setting at all; a reply still goes.
  fails(['agent', 'claude:s1', 'mode', 'next'], 'SESSION_WAITING')
  assert.equal(calls().length, 5)
  assert.match(run('reply', 'claude:s1', '--text', 'yes'), /state: delivered/)
})
