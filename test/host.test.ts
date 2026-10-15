import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { commands } from '../src/cli/commands.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { agent, sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { workerCommands } from '../src/cli/workers.ts'
import { decideOutcome, decidePush, decideSession } from '../src/core/decide.ts'
import type { Card } from '../src/core/model.ts'
import { createHost, type QueryFn } from '../src/server/host.ts'
import { startServer, type RunningServer } from '../src/server/server.ts'
import { askHost } from '../src/server/state.ts'
import { loadBoard, spoolWrite, withWriter } from '../src/store/board-store.ts'

const meta = { at: '2026-10-15T00:00:00Z', actor: 'test' }
let server: RunningServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

// Claude Code as the Agent SDK presents it: each message runs a turn that ends at
// once, or waits for release() while hold is set.
function fakeSdk() {
  const calls: { options: Options; messages: string[]; set: string[]; closed: boolean }[] = []
  const gates: (() => void)[] = []
  const control = { hold: false }

  const query = (({ prompt, options }: {
    prompt: AsyncIterable<{ message: { content: unknown } }>
    options: Options
  }) => {
    const call = { options, messages: [] as string[], set: [] as string[], closed: false }
    calls.push(call)

    async function* run() {
      for await (const message of prompt) {
        call.messages.push(String(message.message.content))
        yield { type: 'system', subtype: 'session_state_changed', state: 'running' }

        if (control.hold) {
          await new Promise<void>(resolve => gates.push(resolve))
        }

        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' }
      }
    }

    return Object.assign(run(), {
      setModel: async (model: string) => {
        call.set.push(`model ${model}`)
      },
      setPermissionMode: async (mode: string) => {
        call.set.push(`mode ${mode}`)
      },
      applyFlagSettings: async (settings: Record<string, unknown>) => {
        call.set.push(`effort ${String(settings.effortLevel)}`)
      },
      close: () => {
        call.closed = true
      },
    })
  }) as unknown as QueryFn

  return { query, calls, control, release: () => gates.splice(0).forEach(open => open()) }
}

async function until({ check, what }: { check: () => boolean; what: string }) {
  for (let i = 0; i < 200; i++) {
    if (check()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.fail(`timed out waiting for ${what}`)
}

async function lab() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-host-')))
  process.env.PNYX_HOME = join(root, 'pnyx')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  const folder = join(root, 'work')
  mkdirSync(folder)
  await commands.board(['create', 'lab', '--board', 'lab'])
  await commands.task(['create', '--title', 'Ship it', '--key', 'ship', '--folder', folder, '--board', 'lab'])
  await commands.task(['brief', 'ship', '--brief', 'Release the canary.', '--board', 'lab'])

  const task = () => {
    const state = loadBoard({ board: 'lab' }).state

    return state.cards[state.keys.ship!]! as Card
  }

  return { folder, task, cards: () => Object.keys(loadBoard({ board: 'lab' }).state.cards).length }
}

const hook = ({ id, event, session, cwd }: {
  id: string
  event: string
  session: string
  cwd: string
}) => {
  spoolWrite({ board: 'lab', entry: { v: 1, id, at: meta.at, harness: 'claude', event, payload: { session_id: session, cwd, prompt: 'Release the canary.' } } })
  ingestSpool({ board: 'lab' })
}

test('task start runs Claude Code through the server, records it on the task and takes replies', async () => {
  const { folder, task, cards } = await lab()
  await workerCommands.kind(['set', 'default', '--harness', 'claude', '--model', 'opus', '--effort', 'high', '--mode', 'acceptEdits', '--board', 'lab'])
  const sdk = fakeSdk()
  server = await startServer({ board: 'lab', query: sdk.query })

  const started = await startTask({ board: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
  assert.equal((started.agent as { host: string }).host, 'pnyx')
  const agentRef = task().agent!
  assert.equal(agentRef.host, 'pnyx')
  assert.equal(agentRef.provider, 'claude-code')
  assert.equal(agentRef.cwd, folder)
  assert.deepEqual(task().settings, { model: 'opus', effort: 'high', mode: 'acceptEdits' })
  await until({ check: () => sdk.calls[0]?.messages.length === 1, what: 'the opening prompt' })

  const { options, messages } = sdk.calls[0]!
  assert.match(messages[0]!, /^Release the canary\.\n\nYou are the Pnyx worker for task/)
  assert.equal(options.sessionId, agentRef.sessionId)
  assert.equal(options.resume, undefined)
  assert.equal(options.cwd, folder)
  assert.deepEqual(options.settingSources, ['user', 'project', 'local'])
  assert.equal(options.permissionPrompts, 'none')
  assert.equal(options.model, 'opus')
  assert.equal(options.effort, 'high')
  assert.equal(options.permissionMode, 'acceptEdits')
  assert.equal(options.env?.PNYX_BOARD, 'lab')
  assert.equal(options.env?.PNYX_TASK, undefined)
  await until({ check: () => task().sessionActivity === 'finished', what: 'the turn to finish' })

  // A repeated start never starts a second agent.
  assert.equal((await startTask({ board: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })).event, 'none: duplicate')
  assert.equal(sdk.calls.length, 1)

  // The session's own hooks land on the same task, never on a new card.
  const before = cards()
  hook({ id: 'h1', event: 'UserPromptSubmit', session: agentRef.sessionId, cwd: folder })
  hook({ id: 'h2', event: 'Stop', session: agentRef.sessionId, cwd: folder })
  assert.equal(cards(), before + 0)
  assert.equal(task().agent?.host, 'pnyx')
  assert.equal(task().sessionIds?.length, 1)

  sdk.control.hold = true
  const receipt = await sendReply({ board: 'lab', request: { card: 'ship', text: 'Also tag it', homes: [], actor: 'test' } })
  assert.equal(receipt.state, 'delivered')
  await until({ check: () => sdk.calls[0]!.messages.length === 2, what: 'the reply' })
  assert.equal(sdk.calls[0]!.messages[1], 'Also tag it')
  assert.equal(task().sessionActivity, 'working')
  sdk.release()
  await until({ check: () => task().sessionActivity === 'finished', what: 'the reply turn to finish' })
  assert.equal(sdk.calls.length, 1)
})

test('after a server restart the task keeps its agent, marks an interrupted turn and resumes the session', async () => {
  const { folder, task } = await lab()
  const first = fakeSdk()
  first.control.hold = true
  server = await startServer({ board: 'lab', query: first.query })
  await startTask({ board: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
  await until({ check: () => first.calls[0]?.messages.length === 1, what: 'the opening prompt' })
  const agentRef = task().agent!
  // Claude Code wrote its transcript, so the session can be resumed.
  mkdirSync(dirname(agentRef.transcriptPath!), { recursive: true })
  writeFileSync(agentRef.transcriptPath!, '')

  await server.close()
  assert.equal(first.calls[0]!.closed, true)
  // Claude Code reports its session ended when its process stops; the hosted session goes on.
  hook({ id: 'end', event: 'SessionEnd', session: agentRef.sessionId, cwd: folder })
  assert.notEqual(task().activity, 'ended')
  assert.equal(task().outcome, undefined)

  const second = fakeSdk()
  server = await startServer({ board: 'lab', query: second.query })
  assert.equal(task().agent?.sessionId, agentRef.sessionId)
  assert.equal(task().activity, 'interrupted')
  assert.equal(task().attention[0]?.key, 'pnyx:interrupted')
  assert.equal(second.calls.length, 0)

  assert.equal((await sendReply({ board: 'lab', request: { card: 'ship', text: 'Carry on', homes: [], actor: 'test' } })).state, 'delivered')
  await until({ check: () => second.calls[0]?.messages.length === 1, what: 'the resumed session' })
  assert.equal(second.calls[0]!.options.resume, agentRef.sessionId)
  assert.equal(second.calls[0]!.options.sessionId, undefined)
  assert.equal(task().attention.some(a => a.key === 'pnyx:interrupted'), false)
  await until({ check: () => task().sessionActivity === 'finished', what: 'the resumed turn to finish' })
})

test('pickers set a hosted agent directly, and a stopped server refuses the send', async () => {
  await lab()
  const sdk = fakeSdk()
  server = await startServer({ board: 'lab', query: sdk.query })
  await startTask({ board: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
  await until({ check: () => sdk.calls[0]?.messages.length === 1, what: 'the opening prompt' })

  const changed = await agent(['ship', 'model', 'sonnet', '--board', 'lab']) as { agent: { sent: string; confirmed: boolean } }
  assert.equal(changed.agent.sent, 'delivered')
  assert.equal(changed.agent.confirmed, true)
  assert.deepEqual(sdk.calls[0]!.set, ['model sonnet'])
  await assert.rejects(agent(['ship', 'model', 'gpt', '--board', 'lab']), /offers no model gpt/)

  await server.close()
  server = undefined
  const receipt = await sendReply({ board: 'lab', request: { card: 'ship', text: 'Anyone there?', homes: [], actor: 'test' } })
  assert.equal(receipt.state, 'failed')
  assert.match(receipt.detail!, /not running; nothing was sent/)
})

test('the host keeps the server\'s own context out of the agent, and refuses what it cannot run', async () => {
  const { folder, task } = await lab()
  const sdk = fakeSdk()
  process.env.PNYX_ACTOR = 'hydra'
  process.env.TMUX_PANE = '%9'

  try {
    server = await startServer({ board: 'lab', query: sdk.query })
    await startTask({ board: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
  } finally {
    delete process.env.PNYX_ACTOR
    delete process.env.TMUX_PANE
  }

  await until({ check: () => sdk.calls[0]?.messages.length === 1, what: 'the opening prompt' })
  const env = sdk.calls[0]!.options.env!
  assert.equal(env.PNYX_ACTOR, undefined)
  assert.equal(env.TMUX_PANE, undefined)
  assert.equal(env.PNYX_BOARD, 'lab')

  const port = new URL(server.url).port
  const unauthorized = await fetch(`http://127.0.0.1:${port}/host`, { method: 'POST', body: JSON.stringify({ action: 'send', card: 'ship', text: 'hi' }) })
  assert.equal(unauthorized.status, 401)
  await assert.rejects(askHost({ board: 'lab', body: { action: 'set', card: 'ship', setting: 'effort', value: 'huge' } }), /effort cannot be huge/)
  await assert.rejects(askHost({ board: 'lab', body: { action: 'start', task: 'ship', prompt: 'Go', id: 'rel', folder: 'work' } }), /absolute path/)

  // A gone folder fails the send and leaves the task as it was.
  await until({ check: () => task().sessionActivity === 'finished', what: 'the turn to finish' })
  await server.close()
  server = await startServer({ board: 'lab', query: sdk.query })
  rmSync(folder, { recursive: true })
  const lost = await sendReply({ board: 'lab', request: { card: 'ship', text: 'Still there?', homes: [], actor: 'test' } })
  assert.equal(lost.state, 'failed')
  assert.match(lost.detail!, /folder .* is gone/)
  assert.equal(task().sessionActivity, 'finished')
})

test('a new agent on the task does not inherit the old one\'s interrupted turn', async () => {
  const { folder, task } = await lab()
  const sdk = fakeSdk()
  sdk.control.hold = true
  server = await startServer({ board: 'lab', query: sdk.query })
  await startTask({ board: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
  await until({ check: () => sdk.calls[0]?.messages.length === 1, what: 'the opening prompt' })
  await server.close()
  server = await startServer({ board: 'lab', query: sdk.query })
  assert.equal(task().attention[0]?.key, 'pnyx:interrupted')

  await commands.task(['detach', 'ship', '--board', 'lab'])
  assert.equal(task().attention.some(a => a.key === 'pnyx:interrupted'), false)
  sdk.control.hold = false
  await startTask({ board: 'lab', task: 'ship', folder, meta: { ...meta, id: 'start-2' } })
  await until({ check: () => sdk.calls.length === 2 && task().sessionActivity === 'finished', what: 'the new agent' })
  assert.equal(task().attention.some(a => a.key === 'pnyx:interrupted'), false)
})

function outside({ folder, provider = 'claude-code', activity = 'ended', pid }: {
  folder: string
  provider?: string
  activity?: string
  pid?: string
}) {
  withWriter({
    board: 'lab',
    fn: ({ writer }) => {
      const stamp = { ...meta, at: new Date().toISOString() }
      const pushed = decidePush({ state: writer.state, key: 'outside', input: { agent: { provider, sessionId: 'native-session', cwd: folder }, terminal: { tty: '/dev/ttys123', ...(pid ? { pid } : {}) }, settings: { model: 'sonnet', effort: 'high' }, activity, source: { adapter: 'hooks', instanceId: 'claude', objectId: 'native-session', observedAt: stamp.at } }, meta: stamp })
      assert.ok('event' in pushed); writer.append({ event: pushed.event })
      const ended = decideOutcome({ state: writer.state, ref: 'outside', outcome: { state: 'ended' }, source: 'hooks', meta: stamp })
      assert.ok('event' in ended); writer.append({ event: ended.event })
      const attached = decideSession({ state: writer.state, ref: `${provider}:native-session`, task: writer.state.keys.ship!, meta: stamp })
      assert.ok('event' in attached); writer.append({ event: attached.event })
    },
  })
}

test('Continue in Pnyx adopts the same native session lazily, survives restart and routes replies and settings to it', async () => {
  const { folder, task, cards } = await lab()
  outside({ folder })
  const count = cards()
  const sdk = fakeSdk()
  server = await startServer({ board: 'lab', query: sdk.query })
  const check = await commands.task(['continue', 'ship', '--check', '--board', 'lab'])
  assert.equal(check.canContinue, true)
  assert.equal(task().agent?.host, undefined)
  const adopted = await commands.task(['continue', 'ship', '--event-id', 'adopt-1', '--board', 'lab'])
  assert.equal((adopted.agent as { session: string }).session, 'native-session')
  assert.equal(task().agent?.host, 'pnyx')
  assert.equal(task().agent?.resume, true)
  assert.equal(task().agent?.cwd, folder)
  assert.equal(task().outcome, undefined)
  assert.equal(task().sessionActivity, 'finished')
  assert.equal(task().launch?.via, 'pnyx')
  assert.deepEqual(task().terminal, {})
  assert.deepEqual(task().settings, { model: 'sonnet', effort: 'high' })
  assert.equal(sdk.calls.length, 0)
  assert.equal((await commands.task(['continue', 'ship', '--event-id', 'adopt-1', '--board', 'lab'])).event, 'none: duplicate')
  assert.equal(cards(), count)
  await server.close()
  server = await startServer({ board: 'lab', query: sdk.query })
  assert.equal(task().agent?.host, 'pnyx')
  assert.equal((await sendReply({ board: 'lab', request: { card: 'ship', text: 'Continue the release', homes: [], actor: 'test' } })).state, 'delivered')
  await until({ check: () => sdk.calls[0]?.messages.length === 1, what: 'adopted session reply' })
  assert.equal(sdk.calls[0]!.options.resume, 'native-session')
  assert.equal(sdk.calls[0]!.options.sessionId, undefined)
  assert.equal(sdk.calls[0]!.options.cwd, folder)
  await agent(['ship', 'model', 'opus', '--board', 'lab'])
  assert.deepEqual(sdk.calls[0]!.set, ['model opus'])
  hook({ id: 'adopted-hook', event: 'UserPromptSubmit', session: 'native-session', cwd: folder })
  assert.equal(task().agent?.host, 'pnyx')
  assert.equal(cards(), count)
})

test('continuation refuses running and unknown presence without changing the session', async () => {
  const { folder, task } = await lab()
  outside({ folder, pid: '123' })

  for (const state of ['present', 'unknown'] as const) {
    const host = createHost({ board: 'lab', changed: () => {}, presence: () => ({ state, detail: 'fixture presence' }) })
    const before = loadBoard({ board: 'lab' }).state.seq
    assert.equal(host.continue({ task: 'ship', id: 'read', actor: 'test', check: true }).canContinue, false)
    assert.throws(() => host.continue({ task: 'ship', id: 'adopt', actor: 'test' }), state === 'present' ? /still runs in its terminal/ : /cannot confirm/)
    assert.equal(loadBoard({ board: 'lab' }).state.seq, before)
    assert.equal(task().agent?.host, undefined)
    assert.throws(() => host.start({ task: 'ship', replacement: 'claude-code:native-session', id: 'fresh', actor: 'test', settings: {}, folder, prompt: 'Fresh' }), state === 'present' ? /still runs/ : /cannot confirm/)
    assert.equal(task().agent?.sessionId, 'native-session')
    host.close()
  }
})

test('continuation reports a missing folder with a fresh-start hint and rejects unsupported sessions', async () => {
  const { folder, task } = await lab()
  outside({ folder })
  const host = createHost({ board: 'lab', changed: () => {} })
  rmSync(folder, { recursive: true })
  assert.equal(host.continue({ task: 'ship', id: 'read', actor: 'test', check: true }).folderMissing, true)
  assert.throws(() => host.continue({ task: 'ship', id: 'adopt', actor: 'test' }), (error: unknown) => {
    assert.match((error as Error).message, /folder .* is gone/)
    assert.match(JSON.stringify(error), /start fresh from the brief/)

    return true
  })
  assert.equal(task().agent?.host, undefined)
  host.close()
  await commands.task(['detach', 'ship', '--board', 'lab'])
  const empty = createHost({ board: 'lab', changed: () => {} })
  assert.throws(() => empty.continue({ task: 'ship', id: 'none', actor: 'test' }), /outside Claude Code/)
  outside({ folder, provider: 'codex' })
  assert.throws(() => empty.continue({ task: 'ship', id: 'codex', actor: 'test' }), /outside Claude Code/)
  empty.close()
})

test('starting fresh validates the replacement before detaching and starts once from the saved brief', async () => {
  const { folder, task } = await lab()
  outside({ folder })
  const sdk = fakeSdk()
  server = await startServer({ board: 'lab', query: sdk.query })
  const replacement = 'claude-code:native-session'
  const before = loadBoard({ board: 'lab' }).state.seq
  await assert.rejects(startTask({ board: 'lab', task: 'ship', replacement, folder: join(folder, 'missing'), meta: { ...meta, id: 'fresh-1' } }), /folder not found/)
  assert.equal(task().agent?.sessionId, 'native-session')
  assert.equal(loadBoard({ board: 'lab' }).state.seq, before)
  await assert.rejects(startTask({ board: 'lab', task: 'ship', replacement: 'claude-code:other', folder, meta: { ...meta, id: 'stale' } }), /different session/)
  await assert.rejects(startTask({ board: 'lab', task: 'ship', replacement, via: 'paseo', folder, meta }), /uses Pnyx/)
  assert.equal(sdk.calls.length, 0)
  const started = await startTask({ board: 'lab', task: 'ship', replacement, folder, meta: { ...meta, id: 'fresh-1' } })
  assert.equal((started.agent as { host: string }).host, 'pnyx')
  assert.notEqual(task().agent?.sessionId, 'native-session')
  assert.equal(loadBoard({ board: 'lab' }).state.sessions?.[replacement]?.taskId, null)
  await until({ check: () => sdk.calls[0]?.messages.length === 1, what: 'fresh opening prompt' })
  assert.match(sdk.calls[0]!.messages[0]!, /^Release the canary\./)
  assert.equal(sdk.calls[0]!.options.resume, undefined)
  assert.equal((await startTask({ board: 'lab', task: 'ship', replacement, folder, meta: { ...meta, id: 'fresh-1' } })).event, 'none: duplicate')
  assert.equal(sdk.calls.length, 1)
})
