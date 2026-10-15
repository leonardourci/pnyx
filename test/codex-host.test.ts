import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { agent, sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { workerCommands } from '../src/cli/workers.ts'
import { harvestTranscripts } from '../src/integrations/hooks/harvest.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { startServer, type RunningServer } from '../src/server/server.ts'
import { loadBoard, spoolWrite, withWriter } from '../src/store/board-store.ts'
import { fakeCodex } from './codex-fixture.ts'

const meta = { at: '2026-10-15T00:00:00Z', actor: 'test', id: 'start-1' }
let server: RunningServer | undefined

afterEach(async () => {
  await server?.close(); server = undefined
})

async function until({ check }: { check: () => boolean }) {
  for (let i = 0; i < 300; i++) {
    if (check()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.fail('timed out waiting for Codex fixture')
}

async function lab({ refuse }: { refuse?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-codex-')))
  process.env.PNYX_HOME = join(root, 'pnyx')
  process.env.CODEX_HOME = join(root, 'codex')
  await commands.board(['create', 'lab', '--board', 'lab'])
  await commands.task(['create', '--title', 'Ship it', '--key', 'ship', '--folder', root, '--board', 'lab'])
  await commands.task(['brief', 'ship', '--brief', 'Release the canary.', '--board', 'lab'])
  await workerCommands.kind(['set', 'default', '--harness', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'high', '--mode', 'on-request', '--board', 'lab'])
  const fixture = fakeCodex({ root, refuse })
  server = await startServer({ board: 'lab', spawnCodex: fixture.spawnCodex })
  const state = () => loadBoard({ board: 'lab' }).state
  const task = () => state().cards[state().keys.ship!]!
  const send = ({ text }: { text: string }) => sendReply({ board: 'lab', request: { card: 'ship', text, homes: [], actor: 'test' } })

  return { root, fixture, state, task, send }
}

test('Codex starts through app-server by default and records its native thread, history and settings', async () => {
  const { root, fixture, state, task, send } = await lab()
  const result = await startTask({ board: 'lab', task: 'ship', meta })
  assert.deepEqual(result.agent, { harness: 'codex', session: '0199f00d-1111-7000-8000-000000000001', folder: root, host: 'pnyx' })
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.equal(task().agent?.provider, 'codex')
  assert.equal(task().agent?.transcriptPath, fixture.transcript)
  assert.deepEqual(task().settings, { model: 'gpt-6.1-sol', effort: 'high', mode: 'on-request' })
  const start = fixture.messages().find(m => m.method === 'thread/start')!
  assert.deepEqual(start.params, { cwd: root, model: 'gpt-6.1-sol', approvalPolicy: 'on-request' })
  const turns = () => fixture.messages().filter(m => m.method === 'turn/start')
  assert.match(String((turns()[0]!.params!.input as {
    text: string
  }[])[0]!.text), /^Release the canary\.\n\nYou are the Pnyx worker/)
  assert.equal(turns()[0]!.params!.effort, 'high')
  assert.equal(turns()[0]!.params!.approvalPolicy, 'on-request')
  assert.equal((await startTask({ board: 'lab', task: 'ship', meta })).event, 'none: duplicate')
  assert.equal(fixture.children.length, 1)
  const count = Object.keys(state().cards).length

  for (const [id, event] of [['h1', 'UserPromptSubmit'], ['h2', 'Stop'], ['h3', 'SessionEnd']]) {
    spoolWrite({ board: 'lab', entry: { v: 1, id, at: meta.at, harness: 'codex', event, payload: { session_id: task().agent!.sessionId, cwd: root } } })
    ingestSpool({ board: 'lab' })
  }

  assert.equal(Object.keys(state().cards).length, count)
  assert.equal(task().agent?.host, 'pnyx')
  assert.notEqual(task().activity, 'ended')

  await agent(['ship', 'model', 'gpt-6-luna', '--board', 'lab'])
  await agent(['ship', 'effort', 'low', '--board', 'lab'])
  await agent(['ship', 'mode', 'never', '--board', 'lab'])
  await assert.rejects(agent(['ship', 'mode', 'bypassPermissions', '--board', 'lab']), /offers no mode/)
  assert.equal((await send({ text: 'Next turn' })).state, 'delivered')
  await until({ check: () => turns().length === 2 && task().sessionActivity === 'finished' })
  assert.equal(turns()[1]!.params!.model, 'gpt-6-luna')
  assert.equal(turns()[1]!.params!.effort, 'low')
  assert.equal(turns()[1]!.params!.approvalPolicy, 'never')
})

test('Codex closes with the server and lazily resumes its interrupted thread on the next message', async () => {
  const { fixture, task, send } = await lab()
  await startTask({ board: 'lab', task: 'ship', prompt: 'HOLD', meta })
  // The brief prefixes an explicit prompt, so hold a separate turn.
  await until({ check: () => task().sessionActivity === 'finished' })
  await send({ text: 'HOLD' })
  await until({ check: () => fixture.messages().filter(m => m.method === 'turn/start').length === 2 })
  const id = task().agent!.sessionId
  await server!.close()
  const child = fixture.children[0]!
  await until({ check: () => child.exitCode !== null || child.signalCode !== null })
  server = await startServer({ board: 'lab', spawnCodex: fixture.spawnCodex })
  assert.equal(fixture.children.length, 1)
  assert.equal(task().activity, 'interrupted')
  assert.equal(task().attention[0]?.key, 'pnyx:interrupted')
  assert.equal((await send({ text: 'Continue' })).state, 'delivered')
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.equal(fixture.children.length, 2)
  assert.equal(fixture.messages().find(m => m.method === 'thread/resume')?.params?.threadId, id)
  assert.equal(task().agent?.sessionId, id)
  assert.equal(task().attention.some(a => a.key === 'pnyx:interrupted'), false)
})

test('Codex queues replies during a turn and declines approval requests without hanging', async () => {
  const { fixture, task, send } = await lab()
  await startTask({ board: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  await send({ text: 'HOLD' })
  await until({ check: () => fixture.messages().filter(m => m.method === 'turn/start').length === 2 })
  await send({ text: 'DENY' })
  assert.equal(task().sessionActivity, 'working')
  fixture.children[0]!.kill('SIGUSR1')
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.equal(fixture.messages().find(m => m.id === 'approval')?.result?.decision, 'decline')
})

test('a failed Codex start leaves the task free, and a crashed or failed turn is interrupted', async () => {
  const refused = await lab({ refuse: 'thread/start' })
  await assert.rejects(startTask({ board: 'lab', task: 'ship', meta }), /fixture refused thread/)
  assert.equal(refused.task().agent, undefined)
  await server!.close()
  server = undefined
  const { fixture, task, send } = await lab()
  await startTask({ board: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  await send({ text: 'CRASH' })
  await until({ check: () => task().activity === 'interrupted' })
  assert.match(task().attention[0]!.text!, /Codex/)
  await send({ text: 'FAIL' })
  await until({ check: () => fixture.children.length === 2 && task().activity === 'interrupted' })
  assert.match(task().attention[0]!.text!, /fixture failure/)
})

test('an idle Codex process that exits is resumed before accepting the next message', async () => {
  const { fixture, task, send } = await lab()
  await startTask({ board: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  fixture.children[0]!.kill()
  await until({ check: () => fixture.children[0]!.signalCode !== null })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await send({ text: 'Resume after idle exit' })).state, 'delivered')
  await until({ check: () => fixture.children.length === 2 && task().sessionActivity === 'finished' })
  assert.ok(fixture.messages().some(m => m.method === 'thread/resume'))
})

test('a concurrent start is refused and shutdown closes a Codex process still initializing', async () => {
  const { fixture, task } = await lab({ refuse: 'initialize' })
  const starting = startTask({ board: 'lab', task: 'ship', meta })
  void starting.catch(() => {})
  await until({ check: () => fixture.messages().some(m => m.method === 'initialize') })
  await assert.rejects(startTask({ board: 'lab', task: 'ship', meta: { ...meta, id: 'start-2' } }), /already starting/)
  await server!.close()
  server = undefined
  await assert.rejects(starting, /closed|fetch failed/)
  const child = fixture.children[0]!
  await until({ check: () => child.exitCode !== null || child.signalCode !== null })
  assert.equal(task().agent, undefined)
})

test('switching a Claude kind to Codex uses Codex defaults instead of Claude settings', async () => {
  const { root, fixture, task } = await lab()
  await workerCommands.kind(['set', 'default', '--harness', 'claude', '--model', 'opus', '--effort', 'max', '--mode', 'acceptEdits', '--board', 'lab'])
  await startTask({ board: 'lab', task: 'ship', harness: 'codex', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.deepEqual(fixture.messages().find(m => m.method === 'thread/start')!.params, { cwd: root })
  const turn = fixture.messages().find(m => m.method === 'turn/start')!.params!
  assert.equal(turn.model, undefined)
  assert.equal(turn.effort, undefined)
  assert.equal(turn.approvalPolicy, undefined)
  assert.equal(task().settings, undefined)
})

test('a provider override resolves the kind quota for the chosen provider', async () => {
  const { root, fixture, task } = await lab()
  const bin = join(root, 'bin'), args = join(root, 'quota-args')
  mkdirSync(bin)
  const command = join(bin, 'quota-axi')
  writeFileSync(command, `#!/bin/sh
printf '%s\\n' "$@" > "$PNYX_TEST_QUOTA_ARGS"
printf '%s\\n' '{"models":[{"provider":"codex","id":"gpt-6-luna"}]}'
`)
  chmodSync(command, 0o755)
  const before = process.env.PATH
  process.env.PATH = `${bin}:${before}`
  process.env.PNYX_TEST_QUOTA_ARGS = args

  try {
    await workerCommands.kind(['set', 'default', '--harness', 'claude', '--model', 'opus', '--effort', 'max', '--mode', 'acceptEdits', '--quota', 'high', '--board', 'lab'])
    await startTask({ board: 'lab', task: 'ship', harness: 'codex', meta })
  } finally {
    process.env.PATH = before
    delete process.env.PNYX_TEST_QUOTA_ARGS
  }

  await until({ check: () => task().sessionActivity === 'finished' })
  assert.match(readFileSync(args, 'utf8'), /--provider\ncodex\n/)
  assert.equal(fixture.messages().find(m => m.method === 'thread/start')!.params!.model, 'gpt-6-luna')
  assert.deepEqual(task().settings, { model: 'gpt-6-luna' })
})

test('native hook and transcript settings preserve hosted picker changes across restart', async () => {
  const { root, fixture, task, send } = await lab()
  await startTask({ board: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  await send({ text: 'HOLD' })
  await until({ check: () => fixture.messages().filter(m => m.method === 'turn/start').length === 2 })
  await agent(['ship', 'model', 'gpt-6-luna', '--board', 'lab'])
  await agent(['ship', 'effort', 'low', '--board', 'lab'])
  await agent(['ship', 'mode', 'never', '--board', 'lab'])
  const desired = { model: 'gpt-6-luna', effort: 'low', mode: 'never' }
  spoolWrite({
    board: 'lab',
    entry: {
      v: 1,
      id: 'native-settings',
      at: new Date().toISOString(),
      harness: 'codex',
      event: 'PreToolUse',
      payload: {
        session_id: task().agent!.sessionId, cwd: root, model: 'gpt-6.1-sol', effort: 'high', permission_mode: 'on-request', tool_name: 'shell', tool_input: { command: 'true' },
      },
    },
  })
  ingestSpool({ board: 'lab' })
  assert.deepEqual(task().settings, desired)
  appendFileSync(fixture.transcript, `${JSON.stringify({ type: 'turn_context', timestamp: new Date().toISOString(), payload: { model: 'gpt-6.1-sol', effort: 'high', approval_policy: 'on-request' } })}\n`)
  withWriter({ board: 'lab', fn: ({ writer }) => harvestTranscripts({ writer, cardIds: [task().id], at: new Date().toISOString() }) })
  assert.equal(task().settings?.model, desired.model)
  assert.equal(task().settings?.effort, desired.effort)
  assert.equal(task().settings?.mode, desired.mode)
  await server!.close()
  server = await startServer({ board: 'lab', spawnCodex: fixture.spawnCodex })
  await send({ text: 'Continue with selected settings' })
  await until({ check: () => fixture.children.length === 2 && task().sessionActivity === 'finished' })
  const turn = fixture.messages().filter(m => m.method === 'turn/start')
    .at(-1)!.params!
  assert.equal(turn.model, desired.model)
  assert.equal(turn.effort, desired.effort)
  assert.equal(turn.approvalPolicy, desired.mode)
})
