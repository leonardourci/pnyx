import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { BoardEvent, BoardState } from '../src/core/model.ts'

const bin = join(import.meta.dirname, '../dist/cli/pnyx-axi.js')
const execFileAsync = promisify(execFile)

// A board with fake paseo and quota-axi first on PATH; paseo logs its arguments.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-workers-'))
  const tools = join(root, 'bin')
  const log = join(root, 'paseo.log')
  mkdirSync(tools)
  mkdirSync(join(root, 'work'))
  const folder = realpathSync(join(root, 'work'))
  writeFileSync(join(tools, 'paseo'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
[ "$1 $2" = "terminal create" ] && printf '{"id":"term-1","workspaceId":"wks_1"}\\n'
exit 0
`)
  writeFileSync(join(tools, 'quota-axi'), `#!/bin/sh
printf '{"models":[{"provider":"codex","id":"spent","effective":{"effectivePercentRemaining":0}},{"provider":"codex","id":"roomy","effective":{"effectivePercentRemaining":60}}]}\\n'
`)
  chmodSync(join(tools, 'paseo'), 0o755)
  chmodSync(join(tools, 'quota-axi'), 0o755)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${tools}:${process.env.PATH}`, PNYX_HOME: root, PNYX_SEMANTIC: 'off', PASEO_TERMINAL_ID: '', PASEO_WORKSPACE_ID: '', TMUX_PANE: '', HERDR_PANE_ID: '', PNYX_ACTOR: '' }
  // TOON escapes quotes and backslashes; tests read the plain text.
  const run = ({ args, extra = {} }: { args: string[]; extra?: NodeJS.ProcessEnv }) =>
    execFileSync(process.execPath, [bin, ...args], { env: { ...env, ...extra }, encoding: 'utf8' })
      .replace(/\\(["\\])/g, '$1')

  // AXI prints structured errors on stdout.
  const fail = ({ args, extra = {} }: { args: string[]; extra?: NodeJS.ProcessEnv }): string => {
    try {
      run({ args, extra })
    } catch (error) {
      return String((error as { stdout?: string }).stdout)
    }

    return assert.fail(`${args.join(' ')} succeeded`)
  }

  const state = (): BoardState => JSON.parse(readFileSync(join(root, 'boards/default/snapshot.json'), 'utf8')).state
  const events = (): BoardEvent[] => readFileSync(join(root, 'boards/default/events.jsonl'), 'utf8').trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const paseo = () => readFileSync(log, 'utf8').trim()
    .split('\n')
  let n = 0

  // One interactive Claude Code hook from a Paseo terminal, folded in by the next write.
  const hook = ({ session, cwd, terminal }: { session: string; cwd: string; terminal: string }) => {
    const spool = join(root, 'boards/default/spool')
    mkdirSync(spool, { recursive: true })
    n++
    writeFileSync(join(spool, `${String(n).padStart(4, '0')}.json`), JSON.stringify({
      id: `worker-hook-${n}`,
      at: `2026-10-14T12:00:${String(n).padStart(2, '0')}Z`,
      harness: 'claude',
      event: 'SessionStart',
      terminal: { tty: '/dev/ttys009', pid: '9', paseoTerminal: terminal },
      payload: { session_id: session, cwd },
    }))
    run({ args: ['task', 'create', '--title', `probe ${n}`] })
  }

  return { root, folder, run, fail, state, events, paseo, hook }
}

test('kinds configure the agent each kind launches on and validate their flags', () => {
  const f = fixture()
  f.run({ args: ['kind', 'set', 'review', '--harness', 'codex', '--model', 'gpt-5.4', '--effort', 'high', '--mode', 'bypass'] })
  f.run({ args: ['kind', 'set', 'research', '--quota', 'high'] })
  assert.deepEqual(f.state().board!.agents, {
    review: { harness: 'codex', model: 'gpt-5.4', effort: 'high', mode: 'bypass' },
    research: { harness: 'claude', quota: 'high' },
  })
  assert.match(f.run({ args: ['kind'] }), /review,codex,gpt-5\.4,high,bypass,off/)
  f.run({ args: ['kind', 'remove', 'research'] })
  assert.deepEqual(Object.keys(f.state().board!.agents!), ['review'])
  assert.match(f.fail({ args: ['kind', 'set', 'bad', '--model', 'x; rm -rf /'] }), /cannot take/)
  assert.match(f.fail({ args: ['kind', 'set', 'bad', '--harness', 'vim'] }), /--harness/)
  assert.match(f.run({ args: ['kind', 'remove', 'missing'] }), /none: unchanged/)
})

test('worker create previews a quoted command line for each harness, with a quota-picked model', () => {
  const f = fixture()
  f.run({ args: ['task', 'create', '--key', 'w', '--title', "Fix Bob's bug", '--folder', f.folder] })
  const claude = f.run({ args: ['worker', 'create', 'w', '--preview', '--text', "don't push"] })
  assert.match(claude, /PNYX_BOARD='default' PNYX_TASK='c1' PNYX_ACTOR='worker:c1' claude '/)
  assert.match(claude, /Bob'\\''s bug/)
  f.run({ args: ['kind', 'set', 'review', '--harness', 'codex', '--effort', 'high', '--mode', 'bypass', '--quota', 'high'] })
  const codex = f.run({ args: ['worker', 'create', 'w', '--kind', 'review', '--preview'] })
  assert.match(codex, /codex '-m' 'roomy' '-c' 'model_reasoning_effort="high"' '--dangerously-bypass-approvals-and-sandbox'/)
  assert.match(f.fail({ args: ['worker', 'create', 'w', '--kind', 'nope', '--preview'] }), /no agent configured/)
})

test('worker create opens a Paseo terminal, records the launch, and its session joins the task', () => {
  const f = fixture()
  f.run({ args: ['task', 'create', '--key', 'w', '--title', 'Ship it'] })
  f.run({ args: ['hydra', 'send', '--task', 'w', '--action', 'worker', '--event-id', 'ask'] })
  const out = f.run({ args: ['worker', 'create', 'w', '--cwd', f.folder, '--request', 'ask'], extra: { PNYX_ACTOR: 'hydra', PASEO_WORKSPACE_ID: 'wks_9' } })
  assert.match(out, /terminal: term-1/)
  const calls = f.paseo()
  assert.match(calls[0]!, new RegExp(`^terminal create --cwd ${f.folder} --name pnyx c1 Ship it --json --workspace wks_9$`))
  assert.match(calls[1]!, /^terminal send-keys term-1 -l -- PNYX_BOARD='default' PNYX_TASK='c1' .*request: Create a worker for task c1: Ship it/)
  assert.equal(calls[2], 'terminal send-keys term-1 Enter')
  const launched = f.events().find(e => e.type === 'worker.launched')!
  assert.equal(launched.actor, 'hydra')
  assert.deepEqual(launched.data, { kind: 'default', agent: { harness: 'claude' }, folder: f.folder, terminal: 'term-1', request: 'ask' })
  assert.match(f.run({ args: ['task', 'history', 'w'] }), /Launched default worker: claude in/)

  f.hook({ session: 'other', cwd: f.folder, terminal: 'term-2' })
  f.hook({ session: 'mine', cwd: f.folder, terminal: 'term-1' })
  const task = f.state().cards.c1!
  assert.deepEqual(task.sessionIds, ['claude-code:mine'])
  assert.match(f.fail({ args: ['worker', 'create', 'w'] }), /already has a worker/)
})

test('board set --session self binds the session running in the caller\'s Paseo terminal', () => {
  const f = fixture()
  f.hook({ session: 'hydra', cwd: f.folder, terminal: 'term-h' })
  assert.match(f.fail({ args: ['board', 'set', '--session', 'self'] }), /cannot tell this terminal/)
  assert.match(f.fail({ args: ['board', 'set', '--session', 'self'], extra: { PASEO_TERMINAL_ID: 'term-x' } }), /no recorded session/)
  f.run({ args: ['board', 'set', '--session', 'self'], extra: { PASEO_TERMINAL_ID: 'term-h' } })
  assert.equal(f.state().board!.hydra.session, 'claude-code:hydra')
})

test('hydra start launches the hydra kind and refuses a Firstmate Hydra', () => {
  const f = fixture()
  f.run({ args: ['kind', 'set', 'hydra', '--model', 'opus', '--effort', 'max'] })
  const preview = f.run({ args: ['hydra', 'start', '--preview', '--cwd', f.folder] })
  assert.match(preview, /PNYX_BOARD='default' PNYX_ACTOR='hydra' claude '--model' 'opus' '--effort' 'max' 'You are Hydra/)
  f.run({ args: ['hydra', 'start', '--cwd', f.folder] })
  assert.match(f.paseo()[0]!, /^terminal create --cwd .* --name pnyx hydra default --json$/)
  f.run({ args: ['board', 'set', '--firstmate', f.root] })
  assert.match(f.fail({ args: ['hydra', 'start'] }), /Firstmate/)
})

test('hydra check lists only tracked changes by others and waits for the next one', async () => {
  const f = fixture()
  f.run({ args: ['task', 'create', '--key', 'a', '--title', 'First'] })
  const start = f.state().seq
  assert.match(f.run({ args: ['hydra', 'check'] }), new RegExp(`none: nothing Hydra tracks changed after seq ${start}`))
  f.run({ args: ['task', 'create', '--key', 'b', '--title', 'By Hydra'], extra: { PNYX_ACTOR: 'hydra' } })
  f.run({ args: ['task', 'rename', 'a', '--title', 'First, renamed'] })
  f.run({ args: ['task', 'status', 'a', 'needs_you', '--note', 'which db?'], extra: { PNYX_ACTOR: 'worker:c1' } })
  const out = f.run({ args: ['hydra', 'check', '--after', String(start)] })
  assert.match(out, /task\.declared,c1,"worker:c1","needs_you: which db\?"/)
  assert.doesNotMatch(out, /By Hydra|card\.pushed/)
  const through = Number(/through: (\d+)/.exec(out)![1])
  assert.equal(through, f.state().seq)

  const waiting = execFileAsync(process.execPath, [bin, 'hydra', 'check', '--after', String(through), '--wait', '20'], { env: { ...process.env, PNYX_HOME: f.root, PNYX_SEMANTIC: 'off' }, encoding: 'utf8' })
  await new Promise(resolve => setTimeout(resolve, 500))
  f.run({ args: ['hydra', 'send', '--text', 'plan the week'] })
  const { stdout } = await waiting
  assert.match(stdout, /hydra\.message.*Send to Hydra: plan the week/)
})
