import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { commands } from '../src/cli/commands.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { agent, sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { workerCommands } from '../src/cli/workers.ts'
import type { Card } from '../src/core/model.ts'
import type { QueryFn } from '../src/server/host.ts'
import { startServer, type RunningServer } from '../src/server/server.ts'
import { loadBoard, spoolWrite } from '../src/store/board-store.ts'

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
