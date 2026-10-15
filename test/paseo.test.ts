import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PaseoClient } from '@getpaseo/client'
import { decidePush } from '../src/core/decide.ts'
import { localPaseoUrl } from '../src/core/paseo.ts'
import { replyRoute } from '../src/core/route.ts'
import { liveTask } from '../src/core/tasks.ts'
import { openPaseo } from '../src/integrations/paseo/client.ts'
import { paseoStatus, startAgent } from '../src/integrations/paseo/launch.ts'
import { paseoReply } from '../src/integrations/paseo/reply.ts'
import { paseoConversation } from '../src/integrations/paseo/thread.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { startTask } from '../src/cli/start.ts'
import { commands } from '../src/cli/commands.ts'
import { workerCommands } from '../src/cli/workers.ts'

const at = '2026-10-14T12:00:00Z'
const url = 'ws://127.0.0.1:16767/ws'

// A stand-in for the Paseo SDK client. It records calls and never opens a socket.
function fakePaseo({ send }: { send?: () => Promise<void> } = {}) {
  const calls = {
    create: [] as Record<string, unknown>[],
    sent: [] as { agent: string; text: string; id?: string }[],
    closed: 0,
  }
  const agents = new Map<string, string>()
  const client = {
    providers: {
      listModels: async (provider: string) => ({ models: [{ id: `${provider}-small` }, { id: `${provider}-default`, isDefault: true }] }),
    },
    agents: {
      create: async (options: Record<string, unknown>) => {
        calls.create.push(options)
        const id = agents.get(options.idempotencyKey as string) ?? `lab-${agents.size + 1}`
        agents.set(options.idempotencyKey as string, id)

        return { id }
      },
      ref: (agent: string) => ({
        send: send ?? (async (text: string, options?: { messageId?: string }) => {
          calls.sent.push({ agent, text, id: options?.messageId })
        }),
        timeline: {
          subscribe: () => Object.assign(() => undefined, {
            ready: Promise.resolve(),
            release: async () => undefined,
          }),
          refetch: async ({ direction }: { direction: string }) => {
            const seq = direction === 'before' ? 1 : 2

            return {
              epoch: 'lab',
              hasOlder: seq === 2,
              startCursor: { epoch: 'lab', seq },
              staleCursor: false,
              gap: false,
              entries: [{
                seqStart: seq,
                timestamp: at,
                item: seq === 2
                  ? { type: 'assistant_message', text: 'Lab answer' }
                  : { type: 'user_message', text: 'Lab prompt' },
              }],
            }
          },
        },
      }),
    },
    close: async () => {
      calls.closed++
    },
  }

  return { calls, connect: async () => client as unknown as PaseoClient }
}

function hydraId() {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-paseo-'))
  process.env.PNYX_HOME = home
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-paseo-work-')))
  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const decision = decidePush({ state: writer.state, key: 'work', input: { title: 'Lab task', activity: 'waiting' }, meta: { at, actor: 'test' } })
      assert.ok('event' in decision)
      writer.append({ event: decision.event })
    },
  })

  return { folder, state: () => loadHydra({ hydraId: 'lab' }).state }
}

test('Paseo endpoints are local daemons only, with no credentials in the URL', () => {
  assert.equal(localPaseoUrl({ url: 'ws://127.0.0.1:1234/ws' }), 'ws://127.0.0.1:1234/ws')

  for (const bad of ['wss://example.com/ws', 'ws://example.com/ws', 'ws://user:secret@localhost/ws', 'ws://localhost/ws?token=x', 'ws://localhost:1/']) {
    assert.throws(() => localPaseoUrl({ url: bad }), /local/)
  }
})

for (const harness of ['claude', 'codex']) {
  test(`task start runs ${harness} in Paseo with the task's folder and message, then attaches it`, async () => {
    const { folder, state } = hydraId()
    const paseo = fakePaseo()
    const meta = { at, actor: 'test', id: 'start-1' }
    const result = await startAgent({ hydraId: 'lab', task: 'work', harness, prompt: 'Do the lab work', folder, url, meta, connect: paseo.connect })

    assert.equal(result.task, 'c1')
    const [created] = paseo.calls.create
    assert.deepEqual(created, {
      config: { provider: `${harness}/${harness}-default` },
      cwd: folder,
      title: 'Lab task',
      prompt: 'Do the lab work',
      idempotencyKey: 'start-1',
      labels: { 'pnyx.task': 'c1' },
      env: { PNYX_HOME: process.env.PNYX_HOME, PNYX_HYDRA: 'lab' },
    })
    assert.equal(paseo.calls.closed, 1)

    const task = state().cards.c1!
    const provider = harness === 'claude' ? 'claude-code' : 'codex'
    assert.deepEqual(task.sessionIds, [`${provider}:lab-1`])
    assert.equal(task.folder, folder)
    assert.equal(task.agent?.paseoAgentId, 'lab-1')
    assert.equal(task.agent?.paseoUrl, url)
    assert.equal(task.column, 'in_progress')
    const origin = Object.values(state().cards).find(c => c.key === 'paseo:lab-1')!
    assert.equal(liveTask({ card: origin }), false)
    assert.equal(state().sessions?.[`${provider}:lab-1`]?.taskId, 'c1')

    const again = await startAgent({ hydraId: 'lab', task: 'work', harness, prompt: 'Do the lab work', url, meta, connect: paseo.connect })
    assert.equal(again.event, 'none: duplicate')
    assert.equal(paseo.calls.create.length, 1)
    await assert.rejects(
      startAgent({ hydraId: 'lab', task: 'work', harness, prompt: 'Another', url, meta: { ...meta, id: 'start-2' }, connect: paseo.connect }),
      /already has an attached agent/,
    )
    assert.equal(paseo.calls.create.length, 1)
  })
}

test('task start checks its input before reaching Paseo', async () => {
  const { folder } = hydraId()
  const paseo = fakePaseo()
  const meta = { at, actor: 'test' }
  type Input = { harness?: string; prompt?: string; folder?: string }
  const start = ({ ...input }: Input) => startAgent({
    hydraId: 'lab', task: 'work', harness: 'claude', prompt: 'Go', url, meta, connect: paseo.connect, ...input,
  })

  await assert.rejects(start({ harness: 'gemini' }), /unknown harness/)
  await assert.rejects(start({ prompt: '  ' }), /opening message/)
  await assert.rejects(start({}), /choose the folder/)
  await assert.rejects(start({ folder: join(folder, 'missing') }), /folder not found/)
  assert.equal(paseo.calls.create.length, 0)
})

test('a Paseo daemon that is not running gives a clear reason and starts nothing', async () => {
  hydraId()
  // Nothing listens on port 1, so the real client cannot connect.
  const closed = 'ws://127.0.0.1:1/ws'
  await assert.rejects(paseoStatus({ url: closed }), (error: { code: string; message: string }) =>
    error.code === 'PASEO_UNAVAILABLE' && error.message === `Paseo is not running at ${closed}`)
  await assert.rejects(openPaseo({ url: closed }), /Paseo is not running/)
  assert.deepEqual(await paseoStatus({ url, connect: fakePaseo().connect }), { paseo: 'running', url })
})

test('a started task replies through Paseo and reads its conversation from the daemon', async () => {
  const { folder, state } = hydraId()
  const paseo = fakePaseo()
  await startAgent({ hydraId: 'lab', task: 'work', harness: 'codex', prompt: 'Go', folder, url, meta: { at, actor: 'test' }, connect: paseo.connect })
  const card = state().cards.c1!

  const found = replyRoute({ card, homes: [] })
  assert.ok('route' in found && found.route.kind === 'paseo-agent')
  assert.deepEqual(found.route, { kind: 'paseo-agent', agent: 'lab-1', url })
  assert.deepEqual(await paseoReply({ route: found.route, text: 'Continue', id: 'r9', connect: paseo.connect }), { state: 'delivered' })
  assert.deepEqual(paseo.calls.sent, [{ agent: 'lab-1', text: 'Continue', id: 'r9' }])

  const unsure = fakePaseo({
    send: async () => {
      throw new Error('timeout')
    },
  })
  assert.equal((await paseoReply({ route: found.route, text: 'Continue', id: 'r10', connect: unsure.connect })).state, 'delivery_unknown')

  const conversation = await paseoConversation({ card, changed() {}, connect: paseo.connect })

  try {
    const latest = await conversation.read({})
    assert.deepEqual(latest.entries.map(e => [e.role, e.text]), [['assistant', 'Lab answer']])
    assert.equal(latest.via, 'Paseo')
    assert.ok(latest.older?.startsWith('p'))
    const earlier = await conversation.read({ before: latest.older })
    assert.deepEqual(earlier.entries.map(e => [e.role, e.text]), [['user', 'Lab prompt']])
    assert.equal(earlier.older, undefined)
  } finally {
    conversation.close()
  }
})

test('pnyx-axi task start and task paseo report a stopped daemon as structured errors', () => {
  const { folder } = hydraId()
  const bin = join(import.meta.dirname, '../dist/cli/pnyx-axi.js')
  const env = { ...process.env, PNYX_HOME: process.env.PNYX_HOME, PNYX_SEMANTIC: 'off', PNYX_PASEO_URL: 'ws://127.0.0.1:1/ws' }
  const run = ({ args }: { args: string[] }) => spawnSync(process.execPath, [bin, ...args, '--hydra', 'lab'], { env, encoding: 'utf8' })

  const status = run({ args: ['task', 'paseo'] })
  assert.notEqual(status.status, 0)
  assert.match(status.stdout, /PASEO_UNAVAILABLE/)
  assert.match(status.stdout, /Paseo is not running at ws:\/\/127\.0\.0\.1:1\/ws/)
  const start = run({ args: ['task', 'start', 'work', '--via', 'paseo', '--harness', 'claude', '--prompt', 'Go', '--folder', folder] })
  assert.notEqual(start.status, 0)
  assert.match(start.stdout, /PASEO_UNAVAILABLE/)
  assert.match(run({ args: ['task', '--help'] }).stdout, /task start <task> \[--via pnyx\|paseo\] \[--kind <kind>\] \[--harness claude\|codex\] \[--prompt <text>\]/)
})

test('an agent started from a lab home reports its hooks to that home, never to the installed one', async () => {
  const installed = mkdtempSync(join(tmpdir(), 'pnyx-real-home-'))
  const script = join(installed, 'hooks', 'pnyx-hook.sh')
  mkdirSync(join(installed, 'hooks'))
  copyFileSync(join(import.meta.dirname, '../setup/hooks/pnyx-hook.sh'), script)
  const { folder } = hydraId()
  const lab = process.env.PNYX_HOME!
  const paseo = fakePaseo()
  await startAgent({ hydraId: 'lab', task: 'work', harness: 'claude', prompt: 'Go', folder, url, meta: { at, actor: 'test' }, connect: paseo.connect })

  const env = paseo.calls.create[0]!.env as Record<string, string>
  const payload = JSON.stringify({ session_id: 'lab-session', hook_event_name: 'UserPromptSubmit', cwd: folder, prompt: 'Go' })
  const ran = spawnSync('/bin/sh', [script, 'claude', 'UserPromptSubmit'], { input: payload, env: { PATH: process.env.PATH, ...env } })
  assert.equal(ran.status, 0)

  assert.equal(readdirSync(join(lab, 'hydras', 'lab', 'spool')).filter(f => f.endsWith('.json')).length, 1)
  assert.deepEqual(readdirSync(installed), ['hooks'])
})

test('task start uses the task kind\'s model, effort and mode, and opens with the worker prompt', async () => {
  const { folder } = hydraId()
  workerCommands.kind(['set', 'review', '--harness', 'codex', '--model', 'codex-small', '--effort', 'high', '--mode', 'full-access', '--hydra', 'lab'])
  commands.task(['brief', 'work', '--brief', 'Verify the canary.', '--hydra', 'lab'])
  const paseo = fakePaseo()
  await startTask({ hydraId: 'lab', task: 'work', via: 'paseo', kind: 'review', folder, url, meta: { at, actor: 'test', id: 'kind-1' }, connect: paseo.connect })
  const created = paseo.calls.create[0]!
  assert.deepEqual(created.config, { provider: 'codex/codex-small', thinkingOptionId: 'high', modeId: 'full-access' })
  assert.match(String(created.prompt), /^Verify the canary\.\n\n/)
  assert.match(String(created.prompt), /Pnyx worker for task c1 "Lab task" on Hydra lab/)

  const other = hydraId()
  workerCommands.kind(['set', 'review', '--harness', 'codex', '--model', 'missing', '--hydra', 'lab'])
  const refused = fakePaseo()
  await assert.rejects(startTask({ hydraId: 'lab', task: 'work', via: 'paseo', kind: 'review', folder: other.folder, url, meta: { at, actor: 'test', id: 'kind-2' }, connect: refused.connect }), /no codex model missing/)
  assert.equal(refused.calls.create.length, 0)
})
