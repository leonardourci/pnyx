import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { commands } from '../src/cli/commands.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { agent, sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { workerCommands } from '../src/cli/workers.ts'
import type { Card } from '../src/core/model.ts'
import type { QueryFn } from '../src/server/host.ts'
import { startServer, type RunningServer } from '../src/server/server.ts'
import { askHost } from '../src/server/state.ts'
import { permissionEvent } from '../src/core/permissions.ts'
import { loadHydra, readEvents, spoolWrite, withWriter } from '../src/store/hydra-store.ts'

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
  const control = { hold: false, permission: false }
  const permissions: PermissionResult[] = []
  const aborts: AbortController[] = []

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

        if (control.permission) {
          const abort = new AbortController()
          aborts.push(abort)
          const result = await options.canUseTool!('Bash', { command: 'touch allowed.txt' }, { signal: abort.signal, toolUseID: 'tool-1', requestId: 'sdk-request', decisionReason: 'Run a shell command' })
          assert.ok(result)
          permissions.push(result)
        }

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

  return {
    query,
    calls,
    control,
    permissions,
    aborts,
    release: () => gates.splice(0).forEach(open => open()),
  }
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
  await commands.hydra(['create', 'lab', '--hydra', 'lab'])
  await commands.task(['create', '--title', 'Ship it', '--key', 'ship', '--folder', folder, '--hydra', 'lab'])
  await commands.task(['brief', 'ship', '--brief', 'Release the canary.', '--hydra', 'lab'])

  const task = () => {
    const state = loadHydra({ hydraId: 'lab' }).state

    return state.cards[state.keys.ship!]! as Card
  }

  return { folder, task, cards: () => Object.keys(loadHydra({ hydraId: 'lab' }).state.cards).length }
}

const hook = ({ id, event, session, cwd }: {
  id: string
  event: string
  session: string
  cwd: string
}) => {
  spoolWrite({ hydraId: 'lab', entry: { v: 1, id, at: meta.at, harness: 'claude', event, payload: { session_id: session, cwd, prompt: 'Release the canary.' } } })
  ingestSpool({ hydraId: 'lab' })
}

test('task start runs Claude Code through the server, records it on the task and takes replies', async () => {
  const { folder, task, cards } = await lab()
  await workerCommands.kind(['set', 'default', '--harness', 'claude', '--model', 'opus', '--effort', 'high', '--mode', 'acceptEdits', '--hydra', 'lab'])
  const sdk = fakeSdk()
  server = await startServer({ hydraId: 'lab', query: sdk.query })

  const started = await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
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
  assert.equal(options.permissionPrompts, 'host')
  assert.equal(typeof options.canUseTool, 'function')
  assert.equal(options.model, 'opus')
  assert.equal(options.effort, 'high')
  assert.equal(options.permissionMode, 'acceptEdits')
  assert.equal(options.env?.PNYX_HYDRA, 'lab')
  assert.equal(options.env?.PNYX_TASK, undefined)
  await until({ check: () => task().sessionActivity === 'finished', what: 'the turn to finish' })

  // A repeated start never starts a second agent.
  assert.equal((await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })).event, 'none: duplicate')
  assert.equal(sdk.calls.length, 1)

  // The session's own hooks land on the same task, never on a new card.
  const before = cards()
  hook({ id: 'h1', event: 'UserPromptSubmit', session: agentRef.sessionId, cwd: folder })
  hook({ id: 'h2', event: 'Stop', session: agentRef.sessionId, cwd: folder })
  assert.equal(cards(), before + 0)
  assert.equal(task().agent?.host, 'pnyx')
  assert.equal(task().sessionIds?.length, 1)

  sdk.control.hold = true
  const receipt = await sendReply({ hydraId: 'lab', request: { card: 'ship', text: 'Also tag it', homes: [], actor: 'test' } })
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
  server = await startServer({ hydraId: 'lab', query: first.query })
  await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
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
  server = await startServer({ hydraId: 'lab', query: second.query })
  assert.equal(task().agent?.sessionId, agentRef.sessionId)
  assert.equal(task().activity, 'interrupted')
  assert.equal(task().attention[0]?.key, 'pnyx:interrupted')
  assert.equal(second.calls.length, 0)

  assert.equal((await sendReply({ hydraId: 'lab', request: { card: 'ship', text: 'Carry on', homes: [], actor: 'test' } })).state, 'delivered')
  await until({ check: () => second.calls[0]?.messages.length === 1, what: 'the resumed session' })
  assert.equal(second.calls[0]!.options.resume, agentRef.sessionId)
  assert.equal(second.calls[0]!.options.sessionId, undefined)
  assert.equal(task().attention.some(a => a.key === 'pnyx:interrupted'), false)
  await until({ check: () => task().sessionActivity === 'finished', what: 'the resumed turn to finish' })
})

test('pickers set a hosted agent directly, and a stopped server refuses the send', async () => {
  await lab()
  const sdk = fakeSdk()
  server = await startServer({ hydraId: 'lab', query: sdk.query })
  await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
  await until({ check: () => sdk.calls[0]?.messages.length === 1, what: 'the opening prompt' })

  const changed = await agent(['ship', 'model', 'sonnet', '--hydra', 'lab']) as { agent: { sent: string; confirmed: boolean } }
  assert.equal(changed.agent.sent, 'delivered')
  assert.equal(changed.agent.confirmed, true)
  assert.deepEqual(sdk.calls[0]!.set, ['model sonnet'])
  await assert.rejects(agent(['ship', 'model', 'gpt', '--hydra', 'lab']), /offers no model gpt/)

  await server.close()
  server = undefined
  const receipt = await sendReply({ hydraId: 'lab', request: { card: 'ship', text: 'Anyone there?', homes: [], actor: 'test' } })
  assert.equal(receipt.state, 'failed')
  assert.match(receipt.detail!, /not running; nothing was sent/)
})

test('the host keeps the server\'s own context out of the agent, and refuses what it cannot run', async () => {
  const { folder, task } = await lab()
  const sdk = fakeSdk()
  process.env.PNYX_ACTOR = 'hydra'
  process.env.TMUX_PANE = '%9'

  try {
    server = await startServer({ hydraId: 'lab', query: sdk.query })
    await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
  } finally {
    delete process.env.PNYX_ACTOR
    delete process.env.TMUX_PANE
  }

  await until({ check: () => sdk.calls[0]?.messages.length === 1, what: 'the opening prompt' })
  const env = sdk.calls[0]!.options.env!
  assert.equal(env.PNYX_ACTOR, undefined)
  assert.equal(env.TMUX_PANE, undefined)
  assert.equal(env.PNYX_HYDRA, 'lab')

  const port = new URL(server.url).port
  const unauthorized = await fetch(`http://127.0.0.1:${port}/host`, { method: 'POST', body: JSON.stringify({ action: 'send', card: 'ship', text: 'hi' }) })
  assert.equal(unauthorized.status, 401)
  await assert.rejects(askHost({ hydraId: 'lab', body: { action: 'set', card: 'ship', setting: 'effort', value: 'huge' } }), /effort cannot be huge/)
  await assert.rejects(askHost({ hydraId: 'lab', body: { action: 'start', task: 'ship', prompt: 'Go', id: 'rel', folder: 'work' } }), /absolute path/)

  // A gone folder fails the send and leaves the task as it was.
  await until({ check: () => task().sessionActivity === 'finished', what: 'the turn to finish' })
  await server.close()
  server = await startServer({ hydraId: 'lab', query: sdk.query })
  rmSync(folder, { recursive: true })
  const lost = await sendReply({ hydraId: 'lab', request: { card: 'ship', text: 'Still there?', homes: [], actor: 'test' } })
  assert.equal(lost.state, 'failed')
  assert.match(lost.detail!, /folder .* is gone/)
  assert.equal(task().sessionActivity, 'finished')
})

test('a new agent on the task does not inherit the old one\'s interrupted turn', async () => {
  const { folder, task } = await lab()
  const sdk = fakeSdk()
  sdk.control.hold = true
  server = await startServer({ hydraId: 'lab', query: sdk.query })
  await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'start-1' } })
  await until({ check: () => sdk.calls[0]?.messages.length === 1, what: 'the opening prompt' })
  await server.close()
  server = await startServer({ hydraId: 'lab', query: sdk.query })
  assert.equal(task().attention[0]?.key, 'pnyx:interrupted')

  await commands.task(['detach', 'ship', '--hydra', 'lab'])
  assert.equal(task().attention.some(a => a.key === 'pnyx:interrupted'), false)
  sdk.control.hold = false
  await startTask({ hydraId: 'lab', task: 'ship', folder, meta: { ...meta, id: 'start-2' } })
  await until({ check: () => sdk.calls.length === 2 && task().sessionActivity === 'finished', what: 'the new agent' })
  assert.equal(task().attention.some(a => a.key === 'pnyx:interrupted'), false)
})

test('hosted permissions survive hooks, wake Hydra and accept exactly one answer without moving the task', async () => {
  const { folder, task } = await lab()
  const sdk = fakeSdk()
  sdk.control.permission = true
  server = await startServer({ hydraId: 'lab', query: sdk.query })
  await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'permission-start' } })
  await until({ check: () => task().permissions?.[0]?.status === 'pending', what: 'permission request' })
  const request = task().permissions![0]!
  const column = task().column
  assert.equal(request.tool, 'Bash')
  assert.deepEqual(request.input, { command: 'touch allowed.txt' })
  assert.equal(sdk.permissions.length, 0)
  hook({ id: 'permission-hook', event: 'PreToolUse', session: task().agent!.sessionId, cwd: folder })
  assert.equal(task().attention.some(a => a.key.endsWith(request.id) && a.blocking), true)
  const event = readEvents({ hydraId: 'lab' }).find(e => e.type === 'task.permission')!
  const checked = await workerCommands.hydra(['check', '--after', String(event.seq - 1), '--hydra', 'lab'])
  assert.ok((checked.changes as { type: string }[]).some(e => e.type === 'task.permission'))
  const shown = await commands.task(['show', 'ship', '--full', '--hydra', 'lab'])
  assert.deepEqual((shown.task as Card).permissions, task().permissions)
  await assert.rejects(async () => commands.task(['permission', 'ship', request.id, 'allow', '--actor', 'hydra', '--hydra', 'lab']), /need --reason/)
  assert.equal(task().permissions![0]!.status, 'pending')

  const answers = await Promise.allSettled([
    commands.task(['permission', 'ship', request.id, 'allow', '--actor', 'hydra', '--reason', 'The command is scoped to this worktree', '--hydra', 'lab']),
    commands.task(['permission', 'ship', request.id, 'deny', '--actor', 'web', '--hydra', 'lab']),
  ])
  assert.equal(answers.filter(a => a.status === 'fulfilled').length, 1)
  await until({ check: () => sdk.permissions.length === 1, what: 'permission result' })
  const status = task().permissions![0]!.status
  assert.equal(sdk.permissions[0]!.behavior, status)
  assert.equal(task().column, column)
  assert.equal(task().attention.some(a => a.key.endsWith(request.id)), false)
  assert.equal(readEvents({ hydraId: 'lab' }).filter(e => e.type === 'task.permission' && e.data.status !== 'pending').length, 1)

  if (status === 'allow') {
    assert.deepEqual(sdk.permissions[0], { behavior: 'allow' })
    assert.match(loadHydra({ hydraId: 'lab' }).state.hydraMessages!.at(-1)!.text, /Allowed Bash on Ship it: The command is scoped/)
  }
})

test('denial tells the provider why and neither denied nor unknown requests can be answered again', async () => {
  const { task } = await lab()
  const sdk = fakeSdk()
  sdk.control.permission = true
  server = await startServer({ hydraId: 'lab', query: sdk.query })
  await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'deny-start' } })
  await until({ check: () => task().permissions?.length === 1, what: 'permission request' })
  const request = task().permissions![0]!
  await assert.rejects(async () => commands.task(['permission', 'ship', request.id, 'always', '--hydra', 'lab']), /allow\|deny/)
  await assert.rejects(async () => commands.task(['permission', 'ship', 'unknown', 'allow', '--hydra', 'lab']), /not found/)
  await commands.task(['create', '--title', 'Other task', '--key', 'other', '--hydra', 'lab'])
  await assert.rejects(async () => commands.task(['permission', 'other', request.id, 'allow', '--hydra', 'lab']), /not found/)
  await commands.task(['permission', 'ship', request.id, 'deny', '--actor', 'hydra', '--reason', 'Do not write that file', '--hydra', 'lab'])
  await until({ check: () => sdk.permissions.length === 1, what: 'denial result' })
  assert.deepEqual(sdk.permissions, [{ behavior: 'deny', message: 'Do not write that file' }])
  assert.match(loadHydra({ hydraId: 'lab' }).state.hydraMessages!.at(-1)!.text, /Denied Bash.*Do not write that file/)
  await assert.rejects(async () => commands.task(['permission', 'ship', request.id, 'allow', '--hydra', 'lab']), /already deny/)
})

test('provider abort and server close expire pending requests and release the provider', async () => {
  const { task } = await lab()
  const sdk = fakeSdk()
  sdk.control.permission = true
  server = await startServer({ hydraId: 'lab', query: sdk.query })
  await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'abort-start' } })
  await until({ check: () => task().permissions?.length === 1, what: 'permission request' })
  sdk.aborts[0]!.abort()
  await until({ check: () => sdk.permissions.length === 1, what: 'abort result' })
  assert.equal(task().permissions![0]!.status, 'expired')
  assert.equal(sdk.permissions[0]!.behavior, 'deny')
  await sendReply({ hydraId: 'lab', request: { card: 'ship', text: 'Try another command', homes: [], actor: 'test' } })
  await until({ check: () => task().permissions?.length === 2, what: 'second permission' })
  await server.close()
  server = undefined
  assert.equal(task().permissions![1]!.status, 'expired')
  assert.equal(task().attention.some(a => a.key.startsWith('pnyx:permission:')), false)
})

test('restart recovery expires a request left pending by a crash without starting an agent', async () => {
  const { task } = await lab()
  const sdk = fakeSdk()
  server = await startServer({ hydraId: 'lab', query: sdk.query })
  await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'recover-start' } })
  await until({ check: () => task().sessionActivity === 'finished', what: 'turn end' })
  await server.close()
  server = undefined
  withWriter({ hydraId: 'lab', fn: ({ writer }) => writer.append({ event: permissionEvent({ state: writer.state, card: task(), request: { id: 'left-pending', session: task().sessionIds![0]!, tool: 'Bash', input: { command: 'pwd' }, status: 'pending' }, meta }) }) })
  const resumed = fakeSdk()
  server = await startServer({ hydraId: 'lab', query: resumed.query })
  assert.equal(resumed.calls.length, 0)
  assert.equal(task().permissions![0]!.status, 'expired')
  await assert.rejects(async () => commands.task(['permission', 'ship', 'left-pending', 'allow', '--hydra', 'lab']), /already expired/)
})

test('moving a live session expires its old permission and routes its next request to its current task', async () => {
  const { task } = await lab()
  const sdk = fakeSdk()
  sdk.control.permission = true
  server = await startServer({ hydraId: 'lab', query: sdk.query })
  await startTask({ hydraId: 'lab', task: 'ship', meta: { ...meta, id: 'move-start' } })
  await until({ check: () => task().permissions?.length === 1, what: 'initial request' })
  const request = task().permissions![0]!
  const session = task().sessionIds![0]!
  await commands.task(['create', '--title', 'Destination', '--key', 'destination', '--hydra', 'lab'])
  await commands.task(['attach', 'destination', '--session', session, '--hydra', 'lab'])
  await assert.rejects(async () => commands.task(['permission', 'ship', request.id, 'allow', '--hydra', 'lab']), /expired|no longer waits/)
  await until({ check: () => sdk.permissions.length === 1, what: 'old request expires' })
  assert.equal(sdk.permissions[0]!.behavior, 'deny')
  assert.equal(task().permissions![0]!.status, 'expired')
  assert.equal(task().attention.some(a => a.key.endsWith(request.id)), false)
  await sendReply({ hydraId: 'lab', request: { card: 'destination', text: 'Continue here', homes: [], actor: 'test' } })

  const destination = () => {
    const state = loadHydra({ hydraId: 'lab' }).state

    return state.cards[state.keys.destination!]!
  }

  await until({ check: () => destination().permissions?.length === 1, what: 'request on the destination task' })
  const next = destination().permissions![0]!
  assert.equal(next.session, session)
  await commands.task(['permission', 'destination', next.id, 'allow', '--hydra', 'lab'])
  await until({ check: () => sdk.permissions.length === 2, what: 'destination approval' })
  assert.equal(sdk.permissions[1]!.behavior, 'allow')
  await sendReply({ hydraId: 'lab', request: { card: 'destination', text: 'Ask before detaching', homes: [], actor: 'test' } })
  await until({ check: () => destination().permissions?.length === 2, what: 'request before detaching' })
  await commands.task(['detach', 'destination', '--hydra', 'lab'])
  await until({ check: () => sdk.permissions.length === 3, what: 'detaching releases the provider without an answer' })
  assert.equal(destination().permissions![1]!.status, 'expired')
  assert.equal(sdk.permissions[2]!.behavior, 'deny')
  assert.equal(sdk.calls.length, 1)
})
