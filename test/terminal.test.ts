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
  const run = ({ args = [] }: { args?: string[] } = {}) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })

  const fails = ({ args, code }: { args: string[]; code: string }) => {
    try {
      run({ args: [...args] })
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

  const set = ({ file, text }: {
    file: string
    text: string
  }) =>
    writeFileSync(join(stub, file), text)

  const session = ({ key, terminal }: { key: string; terminal: Record<string, string> }) => {
    const file = join(root, `${key}.json`)
    writeFileSync(file, JSON.stringify({ agent: { provider: 'claude-code', sessionId: key }, terminal: { tty: TTY, pid: '4242', ...terminal } }))
    run({ args: ['push', '--key', key, '--file', file] })
  }

  return { root, env, run, fails, calls, set, session }
}

const card = ({ fields }: { fields: Partial<Card> }): Card => ({
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

const reason = ({ c }: { c: Card }) => {
  const r = replyRoute({ card: c, homes: [] })

  return 'reason' in r ? r.reason : r.route.kind
}

test('the innermost recorded host is the route', () => {
  const base = { tty: TTY, pid: '9' }
  assert.equal(reason({ c: card({ fields: { terminal: { ...base, program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3', paseoTerminal: 'p1' } } }) }), 'tmux')
  assert.equal(reason({ c: card({ fields: { terminal: { ...base, program: 'kitty', paseoTerminal: 'p1', herdrSession: 'h', herdrPane: 'p2' } } }) }), 'herdr')
  assert.equal(reason({ c: card({ fields: { terminal: { ...base, program: 'kitty', paseoTerminal: 'p1' } } }) }), 'paseo')
  assert.equal(reason({ c: card({ fields: { terminal: { ...base, program: 'iTerm.app' } } }) }), 'iterm2')
  assert.equal(reason({ c: card({ fields: { terminal: { ...base, program: 'Apple_Terminal' } } }) }), 'terminal-app')
  assert.match(reason({ c: card({ fields: { terminal: { ...base, program: 'vscode' } } }) }), /cannot type into vscode/)
  assert.match(reason({ c: card({ fields: { terminal: { program: 'tmux', tmux: '/tmp/s', tmuxPane: '%1' } } }) }), /TTY was not found/)
  assert.match(reason({ c: card({ fields: {} }) }), /No terminal is recorded/)
  assert.match(reason({ c: card({ fields: { activity: 'ended', terminal: { ...base, program: 'Apple_Terminal' } } }) }), /session ended/)
  assert.match(reason({ c: card({ fields: { agent: { provider: 'claude-code', sessionId: 's', agentId: 'a' } } }) }), /subagent/)
  assert.match(reason({ c: card({ fields: { agent: undefined } }) }), /no Firstmate task or agent session/)
  // A Firstmate task keeps its own send command, even with a terminal recorded.
  const fm = card({ fields: { sourceRefs: [{ adapter: 'firstmate', instanceId: '/fm', objectId: 'task' }], terminal: { ...base, program: 'Apple_Terminal' } } })
  assert.match(reason({ c: fm }), /not configured/)
  assert.deepEqual(replyRoute({ card: fm, homes: ['/fm'] }), { route: { kind: 'firstmate', home: '/fm', task: 'task' } })
  // Values that could reach a command line as options or quotes are dropped.
  assert.deepEqual(terminalFacts({ value: { tty: TTY, tmuxPane: '-t', program: 'a b', pid: '0', paseoTerminal: '--x', extra: 'y' } }), { tty: TTY })
})

test('a tmux reply checks the pane, pastes once and presses Enter', () => {
  const { run, calls, set, session, fails } = hosts()
  session({ key: 's1', terminal: { program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3' } })
  set({ file: 'tmux.out.1', text: `${TTY}\n` })
  const out = run({ args: ['reply', 's1', '--text', 'first line\nsecond line', '--idempotency-key', 'k1'] })
  assert.match(out, /state: delivered/)
  const log = calls()
  assert.deepEqual(log.map(c => c.split('\n')[0]), ['call=ps', 'call=tmux', 'call=tmux', 'call=tmux', 'call=tmux'])
  assert.match(log[0]!, /arg=-p\narg=4242/)
  assert.match(log[1]!, /arg=-S\narg=\/tmp\/tmux-1\/default\narg=display-message\narg=-p\narg=-t\narg=%3\narg=#\{pane_tty\}/)
  assert.match(log[2]!, /arg=load-buffer[\s\S]*stdin=first line\nsecond line/)
  assert.match(log[3]!, /arg=paste-buffer\narg=-p\narg=-d[\s\S]*arg=-t\narg=%3/)
  assert.match(log[4]!, /arg=send-keys\narg=-t\narg=%3\narg=Enter\n$/)
  // The same key never sends twice.
  assert.match(run({ args: ['reply', 's1', '--text', 'first line\nsecond line', '--idempotency-key', 'k1'] }), /sent: false/)
  assert.equal(calls().length, 5)
  assert.match(run({ args: ['history', '--card', 's1', '--kind', 'replied'] }), /reply k1 delivered/)
  fails({ args: ['reply', 's1', '--text', 'x', '--resolve-key', 'k'], code: 'VALIDATION_ERROR' })
})

test('a changed pane or an exited process types nothing', () => {
  const { run, calls, set, session } = hosts()
  session({ key: 's1', terminal: { program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3' } })
  set({ file: 'tmux.out', text: '/dev/ttys099\n' })
  assert.match(run({ args: ['reply', 's1', '--text', 'hi'] }), /state: failed\n {2}detail: tmux pane %3 no longer shows \/dev\/ttys042; nothing was typed/)
  assert.equal(calls().filter(c => /load-buffer|paste-buffer|send-keys/.test(c)).length, 0)

  set({ file: 'ps.out', text: '' })
  set({ file: 'ps.exit', text: '1' })
  assert.match(run({ args: ['reply', 's1', '--text', 'hi'] }), /detail: the session's process 4242 has exited; nothing was typed/)
  set({ file: 'ps.exit', text: '0' })
  set({ file: 'ps.out', text: 'ttys007\n' })
  assert.match(run({ args: ['reply', 's1', '--text', 'hi'] }), /detail: process 4242 no longer runs on \/dev\/ttys042/)
  assert.equal(calls().filter(c => c.startsWith('call=tmux')).length, 1)
})

test('a Paseo reply types literally, then submits; a lost Enter is never resent', () => {
  const { run, calls, set, session } = hosts()
  session({ key: 's1', terminal: { program: 'kitty', paseoTerminal: 'term-1', paseoHome: '/tmp/paseo' } })
  assert.match(run({ args: ['reply', 's1', '--text', 'one\ntwo', '--idempotency-key', 'k1'] }), /state: delivered/)
  const [, typed, enter] = calls()
  assert.ok(typed!.endsWith('arg=terminal\narg=send-keys\narg=--home\narg=/tmp/paseo\narg=term-1\narg=-l\narg=--\narg=\u001b[200~one\ntwo\u001b[201~\n'))
  assert.match(enter!, /arg=term-1\narg=Enter\n$/)

  set({ file: 'paseo.exit.4', text: '1' })
  set({ file: 'paseo.err', text: 'daemon unreachable' })
  const unknown = run({ args: ['reply', 's1', '--text', '/review', '--idempotency-key', 'k2'] })
  assert.match(unknown, /state: delivery_unknown/)
  assert.match(unknown, /the text was typed but Enter was not confirmed: daemon unreachable/)
  assert.match(run({ args: ['reply', 's1', '--text', '/review', '--idempotency-key', 'k2'] }), /sent: false/)
  assert.equal(calls().length, 6)
})

test('a Herdr reply names its session and pane', () => {
  const { run, calls, session } = hosts()
  session({ key: 's1', terminal: { program: 'ghostty', herdrSession: 'work', herdrPane: 'p_7' } })
  assert.match(run({ args: ['reply', 's1', '--text', 'go'] }), /state: delivered/)
  const [, typed, enter] = calls()
  assert.match(typed!, /arg=pane\narg=send-text\narg=p_7\narg=go\narg=--session\narg=work\n$/)
  assert.match(enter!, /arg=pane\narg=send-keys\narg=p_7\narg=enter\narg=--session\narg=work\n$/)
})

test('iTerm2 and Terminal get the text and TTY as AppleScript arguments', () => {
  const { run, calls, set, session } = hosts()
  session({ key: 's1', terminal: { program: 'iTerm.app' } })
  session({ key: 's2', terminal: { program: 'Apple_Terminal' } })
  assert.match(run({ args: ['reply', 's1', '--text', 'say "hi"'] }), /state: delivered/)
  const iterm = calls()[1]!
  assert.match(iterm, /tell application "iTerm2"[\s\S]*end run\narg=\/dev\/ttys042\narg=say "hi"\narg=0.4\n$/)
  assert.match(run({ args: ['reply', 's2', '--text', 'hello'] }), /state: delivered/)
  assert.match(calls()[3]!, /tell application "Terminal"/)

  set({ file: 'osascript.exit', text: '1' })
  set({ file: 'osascript.err', text: 'execution error: no Terminal tab on /dev/ttys042 (4404)' })
  assert.match(run({ args: ['reply', 's2', '--text', 'hello'] }), /state: failed[\s\S]*nothing was typed/)
  set({ file: 'osascript.err', text: 'execution error: Not authorized to send Apple events to Terminal. (-1743)' })
  assert.match(run({ args: ['reply', 's2', '--text', 'hello'] }), /state: failed[\s\S]*Privacy & Security > Automation/)
  set({ file: 'osascript.err', text: 'execution error: something else (-2700)' })
  assert.match(run({ args: ['reply', 's2', '--text', 'hello'] }), /state: delivery_unknown/)
})

test('a card with no route says why', () => {
  const { root, run, fails, session } = hosts()
  session({ key: 's1', terminal: { program: 'vscode' } })
  fails({ args: ['reply', 's1', '--text', 'x'], code: 'NO_ROUTE' })
  writeFileSync(join(root, 'plain.json'), '{"title":"plain"}')
  run({ args: ['push', '--key', 'plain', '--file', join(root, 'plain.json')] })
  fails({ args: ['reply', 'plain', '--text', 'x'], code: 'NO_ROUTE' })
})

const execFileAsync = promisify(execFile)

test('the hook records the terminal the session runs in, past wrapper shells', async () => {
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
})
