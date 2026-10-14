// Hook script, payload normalization and `pnyx-axi setup hooks`. Every path lives in
// a temporary folder: tests never read or edit the real ~/.claude, ~/.codex or ~/.pnyx.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { DEPLOY_COMMANDS, PR_COMMANDS, observe, type HookEnvelope } from '../src/integrations/hooks/observe.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const ROOT = join(import.meta.dirname, '..')
const BIN = join(ROOT, 'dist', 'cli', 'pnyx-axi.js')
const SCRIPT = join(ROOT, 'setup', 'hooks', 'pnyx-hook.sh')
const FIXTURES = join(ROOT, 'test', 'fixtures', 'hooks')
const SESSION = '11111111-2222-4333-8444-555555555555'
const CODEX_SESSION = '019a0000-0000-7000-8000-000000000001'

const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.json`), 'utf8')

function sandbox() {
  // A short base keeps the socket path under the platform's length limit.
  const root = mkdtempSync(join(tmpdir(), 'pnyx-h-'))
  const home = join(root, 'pnyx')
  const claude = join(root, 'claude')
  const codex = join(root, 'codex')
  const env = {
    ...process.env,
    HOME: root,
    PNYX_HOME: home,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: codex,
  }
  const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
  const spool = join(home, 'boards', 'default', 'spool')
  const spooled = () => (existsSync(spool) ? readdirSync(spool).filter(f => f.endsWith('.json') && !f.startsWith('.')) : [])
  // Puts the script where setup installs it, so it finds PNYX_HOME from its own path.
  const script = join(home, 'hooks', 'pnyx-hook.sh')
  mkdirSync(join(home, 'hooks'), { recursive: true })
  copyFileSync(SCRIPT, script)

  return { root, home, claude, codex, env, run, spool, spooled, script }
}

const execFileAsync = promisify(execFile)

async function hook(script: string, args: string[], input: string) {
  const child = execFileAsync('/bin/sh', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  child.child.stdin!.end(input)

  return child
}

test('hook spools one silent JSON line when no service is listening', async () => {
  const { script, spool, spooled } = sandbox()
  const { stdout, stderr } = await hook(script, ['claude', 'UserPromptSubmit'], fixture('claude-user-prompt'))
  assert.equal(stdout, '')
  assert.equal(stderr, '')
  const files = spooled()
  assert.equal(files.length, 1)
  const raw = readFileSync(join(spool, files[0]!), 'utf8')
  assert.equal(raw.split('\n').length, 2, 'one line and a newline')
  const line = JSON.parse(raw)
  assert.equal(line.harness, 'claude')
  assert.equal(line.event, 'UserPromptSubmit')
  assert.match(line.id, /^hook-\d+-\d+$/)
  assert.match(line.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  assert.deepEqual(line.payload, JSON.parse(fixture('claude-user-prompt')))
})

test('hook skips shell commands that are not pull request or deploy commands', async () => {
  const { script, spooled } = sandbox()
  await hook(script, ['claude', 'PreToolUse'], fixture('claude-pre-tool-ls'))
  assert.equal(spooled().length, 0)
  await hook(script, ['claude', 'PreToolUse'], fixture('claude-pre-tool-pr-create'))
  assert.equal(spooled().length, 1)
})

const toolPayload = (command: unknown) => JSON.stringify({ session_id: SESSION, tool_name: 'Bash', tool_input: { command } })

test('hook passes on every listed pull request and deploy command, and not text that only mentions deploy', async () => {
  const { script, spooled } = sandbox()

  for (const command of ['cd deploy-scripts && ls', 'cat docs/deploy.md', 'git log --grep deploy']) {
    await hook(script, ['claude', 'PreToolUse'], toolPayload(command))
  }

  assert.equal(spooled().length, 0)

  for (const command of [...PR_COMMANDS, ...DEPLOY_COMMANDS]) {
    await hook(script, ['claude', 'PreToolUse'], toolPayload(command))
  }

  assert.equal(spooled().length, PR_COMMANDS.length + DEPLOY_COMMANDS.length)
})

test('hook stays silent and exits 0 on bad arguments, bad input and unwritable storage', async () => {
  const { script, home, spooled } = sandbox()

  for (const args of [[], ['other', 'Stop'], ['claude', 'Stop;rm']]) {
    const { stdout, stderr } = await hook(script, args, fixture('claude-stop'))
    assert.equal(stdout + stderr, '')
  }

  assert.equal(spooled().length, 0)
  await hook(script, ['codex', 'Stop'], '')
  assert.equal(JSON.parse(readFileSync(join(home, 'boards', 'default', 'spool', spooled()[0]!), 'utf8')).payload, null)
  // A file where the boards folder should be makes the spool unwritable.
  const blocked = sandbox()
  writeFileSync(join(blocked.home, 'boards'), '')
  const { stdout, stderr } = await hook(blocked.script, ['claude', 'Stop'], fixture('claude-stop'))
  assert.equal(stdout + stderr, '')
})

test("hook sends the line to the board's server socket instead of the spool when one listens", async () => {
  const { script, home, spooled } = sandbox()
  const board = join(home, 'boards', 'default')
  mkdirSync(board, { recursive: true })
  const received: string[] = []
  // Like the server: handles each line when its newline arrives and replies nothing.
  const server = createServer(socket => {
    let data = ''
    socket.on('data', chunk => {
      data += chunk

      for (let at = data.indexOf('\n'); at >= 0; at = data.indexOf('\n')) {
        received.push(data.slice(0, at))
        data = data.slice(at + 1)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(join(board, 'server.sock'), resolve))

  try {
    await hook(script, ['claude', 'Stop'], fixture('claude-stop'))
  } finally {
    server.close()
  }

  assert.equal(received.length, 1)
  assert.equal(JSON.parse(received[0]!).event, 'Stop')
  assert.equal(spooled().length, 0)
})

const envelope = (harness: 'claude' | 'codex', event: string, name: string): HookEnvelope => ({
  v: 1,
  id: 'hook-1-1',
  at: '2026-10-13T14:00:00Z',
  harness,
  event,
  payload: JSON.parse(fixture(name)),
})

test('a session event observes the session card with its folder and transcript', () => {
  const [o, ...rest] = observe(envelope('claude', 'SessionStart', 'claude-session-start'))
  assert.equal(rest.length, 0)
  assert.deepEqual(o, {
    id: '',
    key: `claude:${SESSION}`,
    card: {
      source: { adapter: 'hooks', instanceId: 'claude', objectId: SESSION, observedAt: '2026-10-13T14:00:00Z' },
      agent: {
        provider: 'claude-code',
        sessionId: SESSION,
        transcriptPath: `/work/home/.claude/projects/-work-repo/${SESSION}.jsonl`,
        cwd: '/work/repo',
      },
      autoTitle: { from: 'folder', text: 'repo' },
      activity: 'started',
      settings: { model: 'claude-opus-5-5', mode: 'default' },
    },
    outcome: null,
  })
})

test('a prompt offers its first line as the title, cut to one line; a session end records the ended outcome', () => {
  const [prompt] = observe(envelope('claude', 'UserPromptSubmit', 'claude-user-prompt'))
  assert.deepEqual(prompt!.card.autoTitle, { from: 'prompt', text: 'Open a pull request' })
  assert.equal(prompt!.outcome, null, 'a new prompt reopens an ended session')
  const long = { ...envelope('claude', 'UserPromptSubmit', 'claude-user-prompt'), payload: { session_id: SESSION, prompt: `\n  ${'x'.repeat(150)}\nmore` } }
  assert.equal((observe(long)[0]!.card.autoTitle as { text: string }).text, `${'x'.repeat(99)}…`)
  assert.equal(observe(envelope('claude', 'SessionEnd', 'claude-session-end'))[0]!.outcome, 'ended')
  assert.equal(observe(envelope('claude', 'SubagentStop', 'claude-subagent-stop'))[1]!.outcome, 'ended')
  const bare = envelope('claude', 'SubagentStop', 'claude-subagent-stop')
  const barePayload = bare.payload as Record<string, unknown>
  const noAgent = { ...bare, payload: { ...barePayload, agent_id: undefined } }
  assert.equal(observe(noAgent)[0]!.outcome, undefined, 'a SubagentStop without agent_id never ends the session')
  assert.equal(observe(envelope('claude', 'Stop', 'claude-stop'))[0]!.outcome, undefined, 'a finished turn is not an ended session')
})

test('a subagent event makes sure the parent exists, then observes the child under it', () => {
  const [parent, child] = observe(envelope('claude', 'SubagentStop', 'claude-subagent-stop'))
  assert.equal(parent!.key, `claude:${SESSION}`)
  assert.equal(parent!.ifMissing, true)
  assert.equal(child!.key, `claude:${SESSION}/agent-a1`)
  assert.equal(child!.card.parent, `claude:${SESSION}`)
  assert.equal(child!.card.activity, 'stopped')
  assert.deepEqual(child!.card.autoTitle, { from: 'agent', text: 'Explore t-a1' }, 'a subagent is titled by its type and short id, not the folder')
  const untyped = envelope('claude', 'SubagentStart', 'claude-subagent-start')
  const untypedPayload = untyped.payload as Record<string, unknown>
  const [, bareChild] = observe({ ...untyped, payload: { ...untypedPayload, agent_type: undefined, agent_id: 'b7c9d2' } })
  assert.deepEqual(bareChild!.card.autoTitle, { from: 'agent', text: 'Subagent c9d2' })
  assert.deepEqual(child!.card.agent, {
    provider: 'claude-code',
    sessionId: SESSION,
    agentId: 'agent-a1',
    agentType: 'Explore',
    transcriptPath: `/work/home/.claude/projects/-work-repo/${SESSION}/subagents/agent-a1.jsonl`,
    cwd: '/work/repo',
  })
})

test('tool events report only pull request and deploy commands; a created pull request is a link', () => {
  assert.deepEqual(observe(envelope('claude', 'PreToolUse', 'claude-pre-tool-ls')), [])
  assert.equal(observe(envelope('claude', 'PreToolUse', 'claude-pre-tool-pr-create'))[0]!.card.activity, 'running gh pr create')
  const [created] = observe(envelope('claude', 'PostToolUse', 'claude-post-tool-pr-create'))
  assert.equal(created!.card.activity, 'ran gh pr create')
  assert.equal(created!.link, 'https://github.com/example/repo/pull/42')
  const [deployed] = observe(envelope('codex', 'PostToolUse', 'codex-post-tool-deploy'))
  assert.equal(deployed!.card.activity, 'ran deploy')
  assert.equal(deployed!.link, undefined)
})

test('a deploy counts only when a listed command is in command position', () => {
  const activity = (command: unknown) =>
    observe({ ...envelope('claude', 'PreToolUse', 'claude-pre-tool-ls'), payload: JSON.parse(toolPayload(command)) })[0]?.card.activity

  for (const command of ['cd deploy-scripts && ls', 'cat docs/deploy.md', 'git log --grep deploy', 'echo pnpm run deploy', ['bash', '-lc', 'cat deploy.md']]) {
    assert.equal(activity(command), undefined, String(command))
  }

  for (const command of ['pnpm run deploy', 'git push && wrangler deploy', 'fly deploy', 'pnpm test || vercel --prod', 'make | netlify deploy --dir out', ['bash', '-lc', 'pnpm run deploy']]) {
    assert.equal(activity(command), 'running deploy', String(command))
  }

  assert.equal(activity('git push; gh-axi pr merge 3'), 'running gh pr merge')
})

test('codex payloads map the same way; unknown events and payloads without a session map to nothing', () => {
  const [o] = observe(envelope('codex', 'SessionStart', 'codex-session-start'))
  assert.equal(o!.key, `codex:${CODEX_SESSION}`)
  assert.equal(o!.card.activity, 'resumed')
  assert.deepEqual(o!.card.agent, { provider: 'codex', sessionId: CODEX_SESSION, cwd: '/work/other' })
  assert.deepEqual(observe(envelope('codex', 'PreCompact', 'codex-session-start')), [])
  assert.deepEqual(observe({ ...envelope('claude', 'Stop', 'claude-stop'), payload: {} }), [])
  assert.deepEqual(observe({ ...envelope('claude', 'Stop', 'claude-stop'), payload: null }), [])
})

test('spooled hook events become cards on the next write, and a finished turn never marks a task done', async () => {
  const { script, run, home, spooled } = sandbox()
  const events: [string, string][] = [
    ['SessionStart', 'claude-session-start'],
    ['UserPromptSubmit', 'claude-user-prompt'],
    ['SubagentStart', 'claude-subagent-start'],
    ['SubagentStop', 'claude-subagent-stop'],
    ['PreToolUse', 'claude-pre-tool-ls'],
    ['PostToolUse', 'claude-post-tool-pr-create'],
    ['Stop', 'claude-stop'],
  ]

  for (const [event, name] of events) {
    await hook(script, ['claude', event], fixture(name))
  }

  assert.equal(spooled().length, 6)
  assert.match(run(), /^spool: 6 hook events waiting; the next write ingests them$/m)

  const probe = join(home, 'probe.json')
  writeFileSync(probe, '{}')
  assert.match(run('push', '--key', 'probe', '--file', probe), /^ {2}ingested: 6$/m)
  assert.equal(spooled().length, 0)

  const session = run('card', `claude:${SESSION}`)
  // Same-second hooks may be ingested in either order, so only facts every order shares are checked.
  assert.match(session, /^ {2}column: workers_on_it$/m)
  assert.match(session, /^ {2}workspace: unassigned$/m)
  assert.match(session, /^ {2}title: Open a pull request$/m)
  assert.match(session, /^ {4}cwd: \/work\/repo$/m)
  assert.match(session, /^ {4}transcriptPath: /m)
  assert.match(session, /https:\/\/github\.com\/example\/repo\/pull\/42/)
  assert.doesNotMatch(session, /outcome/)
  const child = run('card', `claude:${SESSION}/agent-a1`)
  assert.match(child, /^ {2}parent: c1$/m)
  assert.match(child, /^ {4}agentId: agent-a1$/m)
  assert.match(run('history', '--limit', '100'), /hook:claude/)
})

test('a hook event ingested twice, from the socket and the spool, is applied once', () => {
  const { run, home } = sandbox()
  const spool = join(home, 'boards', 'default', 'spool')
  mkdirSync(spool, { recursive: true })
  const line = JSON.stringify({ ...envelope('claude', 'SubagentStart', 'claude-subagent-start'), id: 'hook-9-9' })
  writeFileSync(join(spool, '000000000000001-1-a.json'), line)
  writeFileSync(join(spool, '000000000000001-2-b.json'), line)
  const probe = join(home, 'probe.json')
  writeFileSync(probe, '{}')
  run('push', '--key', 'probe', '--file', probe)
  const history = run('history', '--limit', '100')
  assert.equal(history.match(/hook:claude/g)?.length, 2, 'parent and child, once each')
})

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('setup hooks merges into Claude settings, keeps other hooks, and is idempotent', () => {
  const { run, claude, home } = sandbox()
  mkdirSync(claude)
  const settings = join(claude, 'settings.json')
  writeFileSync(settings, fixture('existing-settings'))
  const original = readJson(settings)

  assert.match(run('setup', 'hooks', '--harness', 'claude'), /installed/)
  const installed = readJson(settings)
  assert.equal(installed.model, 'opus')
  assert.deepEqual(installed.hooks.PreCompact, original.hooks.PreCompact)
  assert.deepEqual(installed.hooks.PreToolUse[0], original.hooks.PreToolUse[0])
  assert.deepEqual(installed.hooks.SessionStart[0], original.hooks.SessionStart[0])
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd']

  for (const event of events) {
    const ours = installed.hooks[event].at(-1)
    assert.equal(ours.hooks[0].command, `'${join(home, 'hooks', 'pnyx-hook.sh')}' claude ${event}`)
    assert.equal(ours.hooks[0].timeout, 3)
  }

  assert.equal(installed.hooks.PreToolUse.at(-1).matcher, 'Bash')
  assert.equal(statSync(join(home, 'hooks', 'pnyx-hook.sh')).mode & 0o111, 0o111)

  const bytes = readFileSync(settings, 'utf8')
  assert.match(run('setup', 'hooks', '--harness', 'claude'), /unchanged/)
  assert.equal(readFileSync(settings, 'utf8'), bytes)

  assert.match(run('setup', 'hooks', '--harness', 'claude', '--remove'), /removed/)
  assert.deepEqual(readJson(settings), original)
  assert.match(run('setup', 'hooks', '--harness', 'claude', '--remove'), /unchanged/)
})

test('rerunning setup hooks keeps Pnyx groups in place and updates a changed handler there', () => {
  const { run, claude } = sandbox()
  mkdirSync(claude)
  const settings = join(claude, 'settings.json')
  run('setup', 'hooks', '--harness', 'claude')
  const config = readJson(settings)
  config.hooks.Stop.push({ hooks: [{ type: 'command', command: '/usr/local/bin/notify' }] })
  writeFileSync(settings, JSON.stringify(config, null, 2))
  const bytes = readFileSync(settings, 'utf8')

  assert.match(run('setup', 'hooks', '--harness', 'claude'), /unchanged/)
  assert.equal(readFileSync(settings, 'utf8'), bytes)

  config.hooks.Stop[0].hooks[0].timeout = 30
  writeFileSync(settings, JSON.stringify(config, null, 2))
  assert.match(run('setup', 'hooks', '--harness', 'claude'), /installed/)
  const stop = readJson(settings).hooks.Stop
  assert.equal(stop.length, 2)
  assert.equal(stop[0].hooks[0].timeout, 3)
  assert.equal(stop[1].hooks[0].command, '/usr/local/bin/notify')
})

test('an installed hook command runs silently and spools', () => {
  const { run, claude, spooled } = sandbox()
  run('setup', 'hooks', '--harness', 'claude')
  const command = readJson(join(claude, 'settings.json')).hooks.Stop[0].hooks[0].command
  const out = execFileSync('/bin/sh', ['-c', command], { input: fixture('claude-stop'), encoding: 'utf8' })
  assert.equal(out, '')
  assert.equal(spooled().length, 1)
})

test('setup hooks writes Codex hooks.json, previews without writing, and picks detected harnesses', () => {
  const { run, claude, codex } = sandbox()
  assert.throws(() => run('setup', 'hooks'), (error: { stdout: string }) => /^code: NOT_FOUND$/m.test(error.stdout))

  mkdirSync(codex)
  assert.match(run('setup', 'hooks', '--preview'), /preview: /)
  assert.equal(existsSync(join(codex, 'hooks.json')), false)

  const out = run('setup', 'hooks')
  assert.match(out, /codex/)
  assert.doesNotMatch(out, /settings\.json/)
  assert.match(out, /run `\/hooks` in Codex/)
  const hooks = readJson(join(codex, 'hooks.json')).hooks
  assert.match(hooks.SubagentStop[0].hooks[0].command, / codex SubagentStop$/)
  assert.equal(existsSync(claude), false)

  run('setup', 'hooks', '--remove')
  assert.deepEqual(readJson(join(codex, 'hooks.json')), {})
})

test('setup hooks writes through a symlinked config and refuses invalid JSON', () => {
  const { run, root, claude } = sandbox()
  mkdirSync(claude)
  const real = join(root, 'dotfiles-settings.json')
  writeFileSync(real, '{}')
  symlinkSync(real, join(claude, 'settings.json'))
  run('setup', 'hooks', '--harness', 'claude')
  assert.equal(lstatSync(join(claude, 'settings.json')).isSymbolicLink(), true)
  assert.ok(readJson(real).hooks.Stop)

  writeFileSync(real, '{ not json')
  assert.throws(() => run('setup', 'hooks', '--harness', 'claude'), (error: { stdout: string }) =>
    /^code: VALIDATION_ERROR$/m.test(error.stdout))
  assert.equal(readFileSync(real, 'utf8'), '{ not json')
})

test('an ended session moves to Done, an open question still needs you, and a resumed one is back at work', () => {
  const { run, home } = sandbox()
  const spool = join(home, 'boards', 'default', 'spool')
  mkdirSync(spool, { recursive: true })
  const probe = join(home, 'probe.json')
  writeFileSync(probe, '{}')
  let n = 0

  // Explicit, ordered names: each step is ingested on the next write.
  const send = (event: string, name: string, payload?: object) => {
    n += 1
    const line = { ...envelope('claude', event, name), id: `hook-${n}`, at: `2026-10-13T14:00:${String(n).padStart(2, '0')}Z`, ...(payload ? { payload } : {}) }
    writeFileSync(join(spool, `${String(n).padStart(15, '0')}-1-a.json`), JSON.stringify(line))
    run('push', '--key', 'probe', '--file', probe)
  }

  const card = () => run('card', `claude:${SESSION}`)

  send('SessionStart', 'claude-session-start')
  send('UserPromptSubmit', 'claude-user-prompt')
  send('Stop', 'claude-stop')
  assert.match(card(), /^ {2}column: workers_on_it$/m)
  send('SessionEnd', 'claude-session-end')
  assert.match(card(), /^ {2}column: done$/m)
  assert.match(card(), /^ {2}outcome:\n {4}state: ended\n {4}source: hooks$/m)
  assert.match(run('history', '--kind', 'outcome'), /ended/)

  const question = join(home, 'question.json')
  writeFileSync(question, JSON.stringify({ attention: [{ kind: 'permission', key: 'p1', blocking: true }] }))
  run('push', '--key', `claude:${SESSION}`, '--file', question)
  assert.match(card(), /^ {2}column: needs_you$/m)
  writeFileSync(question, JSON.stringify({ attention: [] }))
  run('push', '--key', `claude:${SESSION}`, '--file', question)
  assert.match(card(), /^ {2}column: done$/m)

  send('SessionStart', 'claude-session-start', { ...JSON.parse(fixture('claude-session-start')), source: 'resume' })
  assert.match(card(), /^ {2}column: workers_on_it$/m)
  assert.throws(() => run('undo', `hook-${n}:outcome`), (error: { stdout: string }) => /^code: NOT_UNDOABLE$/m.test(error.stdout), "a hook's reopen cannot be undone")
  assert.doesNotMatch(card(), /outcome/)
  assert.match(card(), /^ {2}title: Open a pull request$/m, "a resume keeps the first prompt's title")

  send('SubagentStart', 'claude-subagent-start')
  send('SubagentStop', 'claude-subagent-stop')
  assert.match(run('card', `claude:${SESSION}/agent-a1`), /^ {2}column: done$/m)
  assert.match(card(), /^ {2}column: workers_on_it$/m, 'a subagent ending leaves its parent at work')

  send('SessionEnd', 'claude-session-end')
  run('outcome', `claude:${SESSION}`, 'failed', '--event-id', 'manual-failed')
  assert.match(card(), /^ {2}outcome:\n {4}state: failed$/m, "a person's outcome replaces an observed end")
  run('undo', 'manual-failed', '--event-id', 'undo-failed')
  assert.match(card(), /^ {2}outcome:\n {4}state: ended\n {4}source: hooks$/m, "undoing a person's outcome restores the observed end")
  run('undo', 'undo-failed')
  assert.match(card(), /^ {2}outcome:\n {4}state: failed$/m, 'a person can redo their own undo')
  send('UserPromptSubmit', 'claude-user-prompt')
  assert.match(card(), /^ {2}outcome:\n {4}state: failed$/m, "a later hook leaves a person's outcome alone")
})

test('a hook never changes an outcome another source or a person recorded', () => {
  const { run, home } = sandbox()
  const spool = join(home, 'boards', 'default', 'spool')
  mkdirSync(spool, { recursive: true })
  const file = join(home, 'card.json')
  writeFileSync(file, JSON.stringify({ title: 'Mine' }))
  run('push', '--key', `claude:${SESSION}`, '--file', file)
  run('outcome', 'c1', 'cancelled')

  for (const [i, [event, name]] of [['SessionEnd', 'claude-session-end'], ['UserPromptSubmit', 'claude-user-prompt']].entries()) {
    writeFileSync(join(spool, `00000000000000${i}-1-a.json`), JSON.stringify({ ...envelope('claude', event!, name!), id: `hook-${i}` }))
  }

  run('push', '--key', 'probe', '--file', file)
  const card = run('card', `claude:${SESSION}`)
  assert.match(card, /^ {2}outcome:\n {4}state: cancelled$/m)
  assert.match(card, /^ {2}title: Mine$/m, 'a set title is never replaced by the prompt')
})
