import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { HydraState } from '../src/core/model.ts'

const bin = join(import.meta.dirname, '../dist/cli/pnyx-axi.js')
const execFileAsync = promisify(execFile)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-workers-'))
  mkdirSync(join(root, 'work'))
  const folder = realpathSync(join(root, 'work'))
  const env: NodeJS.ProcessEnv = { ...process.env, PNYX_HOME: root, PNYX_SEMANTIC: 'off', PASEO_TERMINAL_ID: '', PASEO_WORKSPACE_ID: '', TMUX_PANE: '', HERDR_PANE_ID: '', PNYX_ACTOR: '' }
  const run = ({ args, extra = {} }: { args: string[]; extra?: NodeJS.ProcessEnv }) =>
    execFileSync(process.execPath, [bin, ...args], { env: { ...env, ...extra }, encoding: 'utf8' })
      .replace(/\\(["\\])/g, '$1')

  const fail = ({ args, extra = {} }: { args: string[]; extra?: NodeJS.ProcessEnv }): string => {
    try {
      run({ args, extra })
    } catch (error) {
      return String((error as { stdout?: string }).stdout)
    }

    return assert.fail(`${args.join(' ')} succeeded`)
  }

  const state = (): HydraState => JSON.parse(readFileSync(join(root, 'boards/default/snapshot.json'), 'utf8')).state
  let n = 0

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

  return { root, folder, run, fail, state, hook }
}

test('kinds configure the agent each kind launches on and validate their flags', () => {
  const f = fixture()
  f.run({ args: ['kind', 'set', 'review', '--harness', 'codex', '--model', 'gpt-5.4', '--effort', 'high', '--mode', 'bypass'] })
  f.run({ args: ['kind', 'set', 'research', '--quota', 'high'] })
  assert.deepEqual(f.state().config!.agents, {
    review: { harness: 'codex', model: 'gpt-5.4', effort: 'high', mode: 'bypass' },
    research: { harness: 'claude', quota: 'high' },
  })
  assert.match(f.run({ args: ['kind'] }), /review,codex,gpt-5\.4,high,bypass,off/)
  f.run({ args: ['kind', 'remove', 'research'] })
  assert.deepEqual(Object.keys(f.state().config!.agents!), ['review'])
  assert.match(f.fail({ args: ['kind', 'set', 'bad', '--model', 'x; rm -rf /'] }), /cannot take/)
  assert.match(f.fail({ args: ['kind', 'set', 'bad', '--harness', 'vim'] }), /--harness/)
  assert.match(f.run({ args: ['kind', 'remove', 'missing'] }), /none: unchanged/)
  assert.equal(f.state().configured, undefined, 'saving a kind does not choose the Hydra')

  f.run({ args: ['kind', 'set', 'review', '--model', 'gpt-5.5', '--mode', '', '--quota', 'medium'] })
  assert.deepEqual(f.state().config!.agents!.review, { harness: 'codex', model: 'gpt-5.5', effort: 'high', quota: 'medium' })
  f.run({ args: ['kind', 'set', 'review', '--quota', 'off'] })
  assert.deepEqual(f.state().config!.agents!.review, { harness: 'codex', model: 'gpt-5.5', effort: 'high' })
  assert.match(f.run({ args: ['kind', 'set', 'review', '--effort', 'high'] }), /none: unchanged/)
  assert.match(f.run({ args: ['history'] }), /hydraId\.agents/)
})

test('Hydra set --session self binds the session running in the caller\'s Paseo terminal', () => {
  const f = fixture()
  f.hook({ session: 'hydra', cwd: f.folder, terminal: 'term-h' })
  assert.match(f.fail({ args: ['hydra', 'set', '--session', 'self'] }), /cannot tell this terminal/)
  assert.match(f.fail({ args: ['hydra', 'set', '--session', 'self'], extra: { PASEO_TERMINAL_ID: 'term-x' } }), /no recorded session/)
  f.run({ args: ['hydra', 'set', '--session', 'self'], extra: { PASEO_TERMINAL_ID: 'term-h' } })
  assert.equal(f.state().config!.hydra.session, 'claude-code:hydra')
})

test('hydra check lists only tracked changes by others and waits for the next one', async () => {
  const f = fixture()
  f.run({ args: ['task', 'create', '--key', 'a', '--title', 'First'] })
  const start = f.state().seq
  assert.match(f.run({ args: ['hydra', 'check'] }), new RegExp(`none: nothing Hydra tracks changed after seq ${start}`))
  f.run({ args: ['task', 'create', '--key', 'b', '--title', 'By Hydra', '--reason', 'split out the docs'], extra: { PNYX_ACTOR: 'hydra' } })
  f.run({ args: ['task', 'rename', 'a', '--title', 'First, renamed'] })
  f.run({ args: ['task', 'status', 'a', 'needs_you', '--note', 'which db?'], extra: { PNYX_ACTOR: 'worker:c1' } })
  const out = f.run({ args: ['hydra', 'check', '--after', String(start)] })
  assert.match(out, /evt_\d+,task\.declared,c1,none,"worker:c1","needs_you: which db\?"/)
  assert.doesNotMatch(out, /task\.created,c\d+,none,hydra|card\.pushed/)
  assert.match(out, /hydra\.message,c\d+,send,hydra,"Hydra: Created By Hydra: split out the docs"/)
  const through = Number(/through: (\d+)/.exec(out)![1])
  assert.equal(through, f.state().seq)

  const waiting = execFileAsync(process.execPath, [bin, 'hydra', 'check', '--after', String(through), '--wait', '20'], { env: { ...process.env, PNYX_HOME: f.root, PNYX_SEMANTIC: 'off' }, encoding: 'utf8' })
  await new Promise(resolve => setTimeout(resolve, 500))
  f.run({ args: ['hydra', 'send', '--text', 'plan the week'] })
  const { stdout } = await waiting
  assert.match(stdout, /hydra\.message,none,send,cli,"Send to Hydra: plan the week"/)

  const before = f.state().seq

  for (let i = 0; i < 22; i++) {
    f.run({ args: ['hydra', 'send', '--text', `note ${i}`] })
  }

  const first = f.run({ args: ['hydra', 'check', '--after', String(before)] })
  assert.equal((first.match(/note \d+/g) ?? []).length, 20)
  const next = Number(/through: (\d+)/.exec(first)![1])
  assert.equal(next, before + 20)
  assert.match(f.run({ args: ['hydra', 'check', '--after', String(next)] }), /note 20.*\n.*note 21/)

  const quiet = f.state().seq
  f.run({ args: ['task', 'hide', 'b', '--reason', 'the owner closed it'], extra: { PNYX_ACTOR: 'hydra' } })
  const started = Date.now()
  const own = f.run({ args: ['hydra', 'check', '--after', String(quiet), '--wait', '1'] })
  assert.ok(Date.now() - started >= 900, 'Hydra\'s own line must not end the wait')
  assert.match(own, /"Hydra: Hid By Hydra: the owner closed it"/)
})
