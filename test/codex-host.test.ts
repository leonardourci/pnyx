import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { agent, sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { harvestTranscripts } from '../src/integrations/hooks/harvest.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { startServer, type RunningServer } from '../src/server/server.ts'
import { askHost } from '../src/server/state.ts'
import { loadHydra, readEvents, spoolWrite, withWriter } from '../src/store/hydra-store.ts'
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
  fakeDispatch({ root })
  process.env.CODEX_HOME = join(root, 'codex')
  await commands.hydra(['create', 'lab', '--hydra', 'lab'])
  await commands.task(['create', '--title', 'Ship it', '--key', 'ship', '--folder', root, '--hydra', 'lab'])
  await commands.task(['brief', 'ship', '--brief', 'Release the canary.', '--hydra', 'lab'])
  await dispatchCommands.rule(['set', 'default', '--harness', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'high', '--mode', 'on-request', '--hydra', 'lab'])
  const fixture = fakeCodex({ root, refuse, models: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'] })
  server = await startServer({ hydraId: 'lab', spawnCodex: fixture.spawnCodex })

  // A start checks the model against the catalog, read once per server; the thread processes come after it.
  if (refuse !== 'initialize') {
    await askHost({ hydraId: 'lab', body: { action: 'models', harness: 'codex' } })
    fixture.children.splice(0)
    fixture.environments.splice(0)
  }

  const state = () => loadHydra({ hydraId: 'lab' }).state
  const task = () => state().cards[state().keys.ship!]!
  const send = ({ text }: { text: string }) => sendReply({ hydraId: 'lab', request: { card: 'ship', text, homes: [], actor: 'test' } })

  return { root, fixture, state, task, send }
}

test('Codex starts through app-server by default and records its native thread, history and settings', async () => {
  const { root, fixture, state, task, send } = await lab()
  const result = await startTask({ hydraId: 'lab', task: 'ship', meta })
  assert.deepEqual(result.agent, { harness: 'codex', session: '0199f00d-1111-7000-8000-000000000001', folder: root, host: 'pnyx' })
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.equal(task().agent?.provider, 'codex')
  assert.equal(fixture.environments[0]?.CODEX_HOME, join(root, 'codex'))
  assert.equal(task().agent?.loginFolder, join(root, 'codex'))
  assert.match(task().launch?.dispatch ?? '', /on codex:test/)
  assert.equal(task().agent?.transcriptPath, fixture.transcript)
  assert.deepEqual(task().settings, { model: 'gpt-6.1-sol', effort: 'high', mode: 'on-request' })
  const start = fixture.messages().find(m => m.method === 'thread/start')!
  assert.deepEqual(start.params, {
    cwd: root,
    config: { 'shell_environment_policy.set.PNYX_HOME': process.env.PNYX_HOME, 'shell_environment_policy.set.PNYX_HYDRA': 'lab', 'features.default_mode_request_user_input': true },
    model: 'gpt-6.1-sol',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  })
  const turns = () => fixture.messages().filter(m => m.method === 'turn/start')
  assert.match(String((turns()[0]!.params!.input as {
    text: string
  }[])[0]!.text), /^Release the canary\.\n\nYou are the Pnyx worker/)
  assert.equal(turns()[0]!.params!.effort, 'high')
  assert.equal(turns()[0]!.params!.approvalPolicy, 'on-request')
  assert.deepEqual(turns()[0]!.params!.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [process.env.PNYX_HOME], networkAccess: true })
  assert.equal((await startTask({ hydraId: 'lab', task: 'ship', meta })).event, 'none: duplicate')
  assert.equal(fixture.children.length, 1)
  const count = Object.keys(state().cards).length

  for (const [id, event] of [['h1', 'UserPromptSubmit'], ['h2', 'Stop'], ['h3', 'SessionEnd']]) {
    spoolWrite({ hydraId: 'lab', entry: { v: 1, id, at: meta.at, harness: 'codex', event, payload: { session_id: task().agent!.sessionId, cwd: root } } })
    ingestSpool({ hydraId: 'lab' })
  }

  assert.equal(Object.keys(state().cards).length, count)
  assert.equal(task().agent?.host, 'pnyx')
  assert.notEqual(task().activity, 'ended')

  await agent(['ship', 'model', 'gpt-6-luna', '--hydra', 'lab'])
  await agent(['ship', 'effort', 'low', '--hydra', 'lab'])
  await agent(['ship', 'mode', 'never', '--hydra', 'lab'])
  await assert.rejects(agent(['ship', 'mode', 'bypassPermissions', '--hydra', 'lab']), /offers no mode/)
  assert.equal((await send({ text: 'Next turn' })).state, 'delivered')
  await until({ check: () => turns().length === 2 && task().sessionActivity === 'finished' })
  assert.equal(turns()[1]!.params!.model, 'gpt-6-luna')
  assert.equal(turns()[1]!.params!.effort, 'low')
  assert.equal(turns()[1]!.params!.approvalPolicy, 'never')
  assert.deepEqual(turns()[1]!.params!.sandboxPolicy, { type: 'dangerFullAccess' })
})

test('Codex closes with the server and lazily resumes its interrupted thread on the next message', async () => {
  const { fixture, task, send } = await lab()
  await startTask({ hydraId: 'lab', task: 'ship', prompt: 'HOLD', meta })
  // The brief prefixes an explicit prompt, so hold a separate turn.
  await until({ check: () => task().sessionActivity === 'finished' })
  await send({ text: 'HOLD' })
  await until({ check: () => fixture.messages().filter(m => m.method === 'turn/start').length === 2 })
  const id = task().agent!.sessionId
  await server!.close()
  const child = fixture.children[0]!
  await until({ check: () => child.exitCode !== null || child.signalCode !== null })
  server = await startServer({ hydraId: 'lab', spawnCodex: fixture.spawnCodex })
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

test('Codex queues replies during a turn and waits for the Hydra to answer its permission', async () => {
  const { fixture, task, send } = await lab()
  await startTask({ hydraId: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  await send({ text: 'HOLD' })
  await until({ check: () => fixture.messages().filter(m => m.method === 'turn/start').length === 2 })
  await send({ text: 'DENY' })
  assert.equal(task().sessionActivity, 'working')
  fixture.children[0]!.kill('SIGUSR1')
  await until({ check: () => task().permissions?.[0]?.status === 'pending' })
  assert.equal(fixture.messages().some(m => m.id === 'approval'), false)
  await commands.task(['permission', 'ship', task().permissions![0]!.id, 'deny', '--hydra', 'lab'])
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.equal(fixture.messages().find(m => m.id === 'approval')?.result?.decision, 'decline')
})

test('a failed Codex start leaves the task free, and a crashed or failed turn is interrupted', async () => {
  const refused = await lab({ refuse: 'thread/start' })
  await assert.rejects(startTask({ hydraId: 'lab', task: 'ship', meta }), /fixture refused thread/)
  assert.equal(refused.task().agent, undefined)
  await server!.close()
  server = undefined
  const { fixture, task, send } = await lab()
  await startTask({ hydraId: 'lab', task: 'ship', meta })
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
  await startTask({ hydraId: 'lab', task: 'ship', meta })
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
  // A candidate without a model needs no catalog, which this Codex could not give.
  await dispatchCommands.rule(['set', 'default', '--harness', 'codex', '--hydra', 'lab'])
  const starting = startTask({ hydraId: 'lab', task: 'ship', meta })
  void starting.catch(() => {})
  await until({ check: () => fixture.messages().some(m => m.method === 'initialize') })
  await assert.rejects(startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'start-2' } }), /already starting/)
  await server!.close()
  server = undefined
  await assert.rejects(starting, /closed|fetch failed/)
  const child = fixture.children[0]!
  await until({ check: () => child.exitCode !== null || child.signalCode !== null })
  assert.equal(task().agent, undefined)
})

test('a Codex start takes the rule\'s Fast and an override on its first turn', async () => {
  const { fixture, task } = await lab()
  await dispatchCommands.rule(['set', 'default', '--harness', 'codex', '--model', 'gpt-6-luna', '--effort', 'low', '--mode', 'on-request', '--fast', 'on', '--hydra', 'lab'])
  await assert.rejects(startTask({ hydraId: 'lab', task: 'ship', override: { mode: 'acceptEdits' }, meta: { ...meta, id: 'bad-mode' } }), /codex has no mode acceptEdits/)
  await startTask({ hydraId: 'lab', task: 'ship', override: { model: 'gpt-6-astra', effort: 'medium' }, meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  const start = fixture.messages().find(m => m.method === 'thread/start')!
  assert.equal(start.params!.model, 'gpt-6-astra')
  assert.equal(start.params!.serviceTier, 'fast')
  const turn = fixture.messages().find(m => m.method === 'turn/start')!
  assert.equal(turn.params!.model, 'gpt-6-astra')
  assert.equal(turn.params!.effort, 'medium')
  assert.equal(turn.params!.serviceTier, 'fast')
  assert.deepEqual(task().launch?.override, { model: 'gpt-6-astra', effort: 'medium' })
})

test('a harness filter never invents an unlisted candidate', async () => {
  const { fixture, task } = await lab()
  await dispatchCommands.rule(['set', 'default', '--harness', 'claude', '--model', 'opus', '--hydra', 'lab'])
  await assert.rejects(startTask({ hydraId: 'lab', task: 'ship', harness: 'codex', meta }), /no usable candidates/)
  assert.equal(fixture.children.length, 0)
  assert.equal(task().agent, undefined)
})

test('a harness filter keeps the selected candidate settings', async () => {
  const { fixture, task } = await lab()
  await dispatchCommands.rule(['set', 'default', '--candidates', JSON.stringify([{ harness: 'claude', model: 'opus', effort: 'max' }, { harness: 'codex', model: 'gpt-6-luna', effort: 'low' }]), '--hydra', 'lab'])
  await startTask({ hydraId: 'lab', task: 'ship', harness: 'codex', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.equal(fixture.messages().find(m => m.method === 'thread/start')!.params!.model, 'gpt-6-luna')
  assert.deepEqual(task().settings, { model: 'gpt-6-luna', effort: 'low' })
})

test('native hook and transcript settings preserve hosted picker changes across restart', async () => {
  const { root, fixture, task, send } = await lab()
  await startTask({ hydraId: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  await send({ text: 'HOLD' })
  await until({ check: () => fixture.messages().filter(m => m.method === 'turn/start').length === 2 })
  await agent(['ship', 'model', 'gpt-6-luna', '--hydra', 'lab'])
  await agent(['ship', 'effort', 'low', '--hydra', 'lab'])
  await agent(['ship', 'mode', 'never', '--hydra', 'lab'])
  const desired = { model: 'gpt-6-luna', effort: 'low', mode: 'never' }
  spoolWrite({
    hydraId: 'lab',
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
  ingestSpool({ hydraId: 'lab' })
  assert.deepEqual(task().settings, desired)
  appendFileSync(fixture.transcript, `${JSON.stringify({ type: 'turn_context', timestamp: new Date().toISOString(), payload: { model: 'gpt-6.1-sol', effort: 'high', approval_policy: 'on-request' } })}\n`)
  withWriter({ hydraId: 'lab', fn: ({ writer }) => harvestTranscripts({ writer, cardIds: [task().id], at: new Date().toISOString() }) })
  assert.equal(task().settings?.model, desired.model)
  assert.equal(task().settings?.effort, desired.effort)
  assert.equal(task().settings?.mode, desired.mode)
  await server!.close()
  server = await startServer({ hydraId: 'lab', spawnCodex: fixture.spawnCodex })
  await send({ text: 'Continue with selected settings' })
  await until({ check: () => fixture.children.length === 2 && task().sessionActivity === 'finished' })
  const turn = fixture.messages().filter(m => m.method === 'turn/start')
    .at(-1)!.params!
  assert.equal(turn.model, desired.model)
  assert.equal(turn.effort, desired.effort)
  assert.equal(turn.approvalPolicy, desired.mode)
})

test('Codex command and file approvals use the same inline permission events and apply only to that call', async () => {
  const { fixture, task, send } = await lab()
  await startTask({ hydraId: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  const column = task().column
  await send({ text: 'ALLOW' })
  await until({ check: () => task().permissions?.length === 1 })
  const command = task().permissions![0]!
  assert.equal(command.tool, 'Command')
  assert.equal(command.input.command, 'touch allowed.txt')
  await commands.task(['permission', 'ship', command.id, 'allow', '--actor', 'hydra', '--reason', 'Scoped to the task folder', '--hydra', 'lab'])
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.equal(task().permissions![0]!.status, 'allow')
  assert.equal(fixture.messages().find(m => m.id === 'approval')?.result?.decision, 'accept')
  await assert.rejects(async () => commands.task(['permission', 'ship', command.id, 'deny', '--hydra', 'lab']), /already allow/)
  await send({ text: 'FILE' })
  await until({ check: () => task().permissions?.length === 2 })
  const file = task().permissions![1]!
  assert.equal(file.tool, 'File change')
  assert.deepEqual(file.input.changes, [{ path: 'allowed.txt', diff: '+approved', kind: { type: 'add' } }])
  await commands.task(['permission', 'ship', file.id, 'allow', '--hydra', 'lab'])
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.deepEqual(fixture.messages().filter(m => m.id === 'approval')
    .map(m => m.result?.decision), ['accept', 'accept'])
  assert.equal(task().column, column)
})

test('Codex resolved requests and a server restart expire approvals rather than leave answer controls', async () => {
  const { fixture, task, send } = await lab()
  await startTask({ hydraId: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  await send({ text: 'CANCEL' })
  await until({ check: () => task().permissions?.length === 1 })
  fixture.children[0]!.kill('SIGUSR2')
  await until({ check: () => task().permissions?.[0]?.status === 'expired' && task().sessionActivity === 'finished' })
  assert.equal(fixture.messages().some(m => m.id === 'approval'), false)
  await send({ text: 'DENY' })
  await until({ check: () => task().permissions?.length === 2 })
  await server!.close()
  server = await startServer({ hydraId: 'lab', spawnCodex: fixture.spawnCodex })
  assert.equal(task().permissions![1]!.status, 'expired')
  assert.equal(task().attention.some(a => a.key.startsWith('pnyx:permission:')), false)
  await assert.rejects(async () => commands.task(['permission', 'ship', task().permissions![1]!.id, 'allow', '--hydra', 'lab']), /already expired/)
})

test('Codex permission profiles grant only the requested turn scope and denial grants nothing', async () => {
  const { fixture, task, send } = await lab()
  await startTask({ hydraId: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })

  for (const [index, choice] of (['allow', 'deny'] as const).entries()) {
    await send({ text: `PERMISSIONS_${choice.toUpperCase()}` })
    await until({ check: () => task().permissions?.length === index + 1 })
    const request = task().permissions![index]!
    assert.equal(request.tool, 'Turn permissions')
    assert.equal(request.input.scope, 'turn')
    await commands.task(['permission', 'ship', request.id, choice, '--hydra', 'lab'])
    await until({ check: () => task().sessionActivity === 'finished' })
    const response = fixture.messages().filter(m => m.id === 'approval')[index]!
    assert.deepEqual(response.result, { permissions: choice === 'allow' ? { network: { enabled: true } } : {}, scope: 'turn' })
  }
})

test('Codex questions and MCP forms wait on the task and get the owner’s answer', async () => {
  const { fixture, task, send } = await lab()
  await startTask({ hydraId: 'lab', task: 'ship', meta })
  await until({ check: () => task().sessionActivity === 'finished' })
  await send({ text: 'QUESTION' })
  await until({ check: () => task().permissions?.length === 1 })
  const question = task().permissions![0]!
  assert.equal(question.tool, 'Question')
  assert.deepEqual(question.questions?.map(q => [q.question, q.options.map(o => o.label)]), [['Cover http links?', ['Yes', 'No']], ['What should the test be called?', []]])
  assert.equal(question.input.threadId, undefined)
  await assert.rejects(async () => commands.task(['permission', 'ship', question.id, 'allow', '--hydra', 'lab']), /needs an answer/)
  await assert.rejects(async () => commands.task(['permission', 'ship', question.id, 'allow', '--answer', '{"answers":[{"pick":[3]},{"text":"x"}]}', '--hydra', 'lab']), /option numbers from 1 to 2/)
  await commands.task(['permission', 'ship', question.id, 'allow', '--answer', '{"answers":[{"pick":[1]},{"text":"covers http"}]}', '--hydra', 'lab'])
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.deepEqual(fixture.messages().find(m => m.id === 'approval')?.result, { answers: { scheme: { answers: ['Yes'] }, name: { answers: ['covers http'] } } })
  assert.deepEqual(task().permissions![0]!.answers, [['Yes'], ['(hidden)']])
  assert.equal(JSON.stringify(readEvents({ hydraId: 'lab' })).includes('covers http'), false)

  await send({ text: 'QUESTION' })
  await until({ check: () => task().permissions?.length === 2 })
  await commands.task(['permission', 'ship', task().permissions![1]!.id, 'deny', '--hydra', 'lab'])
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.deepEqual(fixture.messages().filter(m => m.id === 'approval')[1]?.result, { answers: {} })

  await send({ text: 'ELICIT' })
  await until({ check: () => task().permissions?.length === 3 })
  const elicitation = task().permissions![2]!
  assert.deepEqual(elicitation.form, [{ name: 'priority', type: 'string', options: ['low', 'high'], required: true }])
  await commands.task(['permission', 'ship', elicitation.id, 'allow', '--answer', '{"values":{"priority":"high"}}', '--hydra', 'lab'])
  await until({ check: () => task().sessionActivity === 'finished' })
  assert.deepEqual(fixture.messages().filter(m => m.id === 'approval')[2]?.result, { action: 'accept', content: { priority: 'high' } })

  await send({ text: 'ALLOW' })
  await until({ check: () => task().permissions?.length === 4 })
  const command = task().permissions![3]!
  await assert.rejects(async () => commands.task(['permission', 'ship', command.id, 'allow', '--answer', '{"answers":[]}', '--hydra', 'lab']), /takes allow or deny without an answer/)
  await commands.task(['permission', 'ship', command.id, 'allow', '--hydra', 'lab'])
  await until({ check: () => task().sessionActivity === 'finished' })
})
