import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeProvider } from '#workers/claude.ts'
import { codexProvider } from '#workers/codex.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { agentInput } from '#app/agent-input.ts'
import { inbox } from '#hydra/update-queue.ts'
import { eventClass, nativeIdle } from '#workers/native-session.ts'
import type { AskPermission, HostedEvent, HostedSession, TurnOutcome } from '#workers/provider.ts'
import { claudeRecording, replayCodex } from '#test-harness/fake-agents.ts'
import { until } from '#test-harness/harness.ts'

const permission = async () => ({
  behavior: 'deny' as const,
  message: 'unused',
})
const result = claudeRecording.turn.find(message => message.type === 'result')

function terminal({
  input,
  queued = 0,
  text = 'Done',
}: {
  input?: string
  queued?: number
  text?: string
}): SDKMessage {
  assert.ok(result?.type === 'result' && result.subtype === 'success')

  return {
    ...result,
    uuid: randomUUID(),
    user_message_uuid: input,
    queued_turn_count: queued,
    is_error: false,
    result: text,
  }
}

function observe({
  session,
  input,
  ask = permission,
}: {
  session: HostedSession
  input: ReturnType<typeof inbox>
  ask?: AskPermission
}) {
  const events: HostedEvent[] = []

  const messages = async function* () {
    for await (const message of input) {
      yield {
        id: message.id!,
        text: message.text,
        images: [],
      }
    }
  }

  const read = async () => {
    for await (const event of session.run({
      input: messages(),
      permission: ask,
    })) {
      events.push(event)
    }
  }

  const done = read()
  const outcomes = () => events.flatMap(event => typeof event === 'object' && event.type === 'turn-ended' ? [event.outcome] : [])

  return {
    events,
    outcomes,
    done,
  }
}

test(
  'a Claude foreground result leaves native queued and background work alive, and unknown queue state blocks idle close',
  async t => {
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const input = inbox()
    const observed = observe({
      session,
      input,
    })
    t.after(async () => {
      input.end(); session.close(); await observed.done
    })
    input.push({
      id: 'first',
      text: 'First',
    })
    input.push({
      id: 'second',
      text: 'Second',
    })
    await until({
      what: 'both native queued inputs',
      check: () => native.incoming.length === 2,
    })
    native.send({
      message: {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          {
            task_id: 'job',
            task_type: 'shell',
            description: 'Building',
          },
        ],
        uuid: randomUUID(),
        session_id: session.id,
      },
    })
    native.send({
      message: terminal({
        input: native.incoming[0]!.uuid,
        queued: 1,
      }),
    })
    await until({
      what: 'the first terminal outcome',
      check: () => observed.outcomes().length === 1,
    })
    assert.deepEqual(
      session.snapshot().work.unsettledInputs,
      ['second'],
    )
    assert.equal(
      nativeIdle({ work: session.snapshot().work }),
      false,
    )
    assert.equal(
      native.closed(),
      false,
    )
    native.send({ message: terminal({ input: native.incoming[1]!.uuid }) })
    await until({
      what: 'both terminal outcomes',
      check: () => observed.outcomes().length === 2,
    })
    assert.notEqual(
      observed.outcomes()[0]!.turn,
      observed.outcomes()[1]!.turn,
    )
    assert.equal(
      nativeIdle({ work: session.snapshot().work }),
      false,
    )
    native.send({
      message: {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
        uuid: randomUUID(),
        session_id: session.id,
      },
    })
    await until({
      what: 'native work to settle',
      check: () => nativeIdle({ work: session.snapshot().work }),
    })
    const older = terminal({})
    assert.equal(
      older.type,
      'result',
    )
    delete older.queued_turn_count
    native.send({ message: older })
    await until({
      what: 'an older result without queue knowledge',
      check: () => observed.outcomes().length === 3,
    })
    assert.equal(
      nativeIdle({ work: session.snapshot().work }),
      false,
    )
  },
)

test(
  'Codex retains carried input after the first finished turn and settles it in its own native turn',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-native-codex-',
    ))
    const native = replayCodex({ hydra: () => 'fixture' })
    const first = native.plan({
      text: 'First',
      hold: true,
    })
    const second = native.plan({
      text: 'Second',
      hold: true,
    })
    const input = inbox()
    const session = await codexProvider({ spawnCodex: native.spawnCodex }).open({
      cwd: root,
      env: {
        PNYX_HOME: root,
        PNYX_HYDRA: 'fixture',
      },
      settings: {},
      signal: new AbortController().signal,
    })
    const observed = observe({
      session,
      input,
    })
    t.after(async () => {
      first.release(); second.release(); input.end(); session.close(); await observed.done; rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    input.push({
      id: 'first',
      text: 'First',
    })
    await until({
      what: 'the first Codex turn',
      check: () => native.sessions[0]?.received.length === 1,
    })
    const decision = await native.sessions[0]!.ask!({
      id: 'approval',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'build' },
    })
    assert.deepEqual(
      decision,
      { decision: 'decline' },
    )
    assert.equal(
      session.snapshot().answers[0]!.permission,
      'string:approval',
    )
    assert.equal(
      session.snapshot().answers[0]!.phase,
      'submitted',
    )
    assert.deepEqual(
      session.snapshot().work.pendingControls,
      [],
    )
    await until({
      what: 'the Codex answer receipts',
      check: () => observed.events.some(event => typeof event === 'object' && event.type === 'answer' && event.receipt.phase === 'submitted'),
    })
    assert.deepEqual(
      observed.events.flatMap(event => typeof event === 'object' && event.type === 'answer' ? [event.receipt.phase] : []),
      [
        'received',
        'submitted',
      ],
    )
    native.control.refuse = 'turn/steer'
    input.push({
      id: 'second',
      text: 'Second',
    })
    await until({
      what: 'the carried receipt',
      check: () => observed.events.some(event => typeof event === 'object' && event.type === 'input' && event.receipt.phase === 'carried'),
    })
    first.release()
    await until({
      what: 'the carried turn to start',
      check: () => native.sessions[0]?.received.length === 2,
    })
    assert.equal(
      observed.outcomes().length,
      1,
    )
    assert.deepEqual(
      observed.outcomes()[0]!.inputIds,
      ['first'],
    )
    assert.deepEqual(
      session.snapshot().work.unsettledInputs,
      ['second'],
    )
    assert.equal(
      nativeIdle({ work: session.snapshot().work }),
      false,
    )
    second.release()
    await until({
      what: 'the carried turn result',
      check: () => observed.outcomes().length === 2,
    })
    assert.deepEqual(
      observed.outcomes()[1]!.inputIds,
      ['second'],
    )
    assert.equal(
      nativeIdle({ work: session.snapshot().work }),
      true,
    )

    const agent = native.sessions[0]!
    agent.notify!({
      method: 'item/completed',
      params: {
        item: {
          type: 'collabAgentToolCall',
          id: 'spawn',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['child'],
          agentsStates: { child: { status: 'running' } },
        },
      },
    })
    await until({
      what: 'the native child inventory',
      check: () => {
        const background = session.snapshot().work.background

        return background.knowledge === 'known' && background.tasks.length === 1
      },
    })
    assert.equal(
      nativeIdle({ work: session.snapshot().work }),
      false,
    )
    agent.notify!({
      method: 'item/completed',
      params: {
        item: {
          type: 'collabAgentToolCall',
          id: 'close',
          tool: 'closeAgent',
          status: 'completed',
          receiverThreadIds: ['child'],
          agentsStates: { child: { status: 'shutdown' } },
        },
      },
    })
    await until({
      what: 'the closed native child',
      check: () => nativeIdle({ work: session.snapshot().work }),
    })
    agent.notify!({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'command',
          processId: 'process',
          status: 'inProgress',
          exitCode: null,
        },
      },
    })
    await until({
      what: 'the background command',
      check: () => !nativeIdle({ work: session.snapshot().work }),
    })
    agent.notify!({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'command',
          processId: 'process',
          status: 'completed',
          exitCode: 0,
        },
      },
    })
    await until({
      what: 'the exited command',
      check: () => nativeIdle({ work: session.snapshot().work }),
    })
    agent.notify!({
      method: 'item/started',
      params: {
        item: {
          type: 'futureNativeWork',
          id: 'unknown',
        },
      },
    })
    await until({
      what: 'unknown native work',
      check: () => session.snapshot().work.background.knowledge === 'unknown',
    })
    assert.equal(
      nativeIdle({ work: session.snapshot().work }),
      false,
    )
  },
)

test(
  'a failed Codex compaction retains the native turn ID, error and failed terminal status',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-native-compact-',
    ))
    const native = replayCodex({ hydra: () => 'fixture' })
    native.control.compact = 'failed'
    const session = await codexProvider({ spawnCodex: native.spawnCodex }).open({
      cwd: root,
      env: {
        PNYX_HOME: root,
        PNYX_HYDRA: 'fixture',
      },
      settings: {},
      signal: new AbortController().signal,
    })
    const input = inbox()
    const observed = observe({
      session,
      input,
    })
    t.after(async () => {
      input.end(); session.close(); await observed.done; rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    input.push({
      id: 'compact',
      text: '/compact',
    })
    await until({
      what: 'the failed compact outcome',
      check: () => observed.outcomes().length === 1,
    })
    assert.equal(
      observed.outcomes()[0]!.status,
      'failed',
    )
    assert.equal(
      observed.outcomes()[0]!.error,
      'Synthetic compaction failure',
    )
    assert.equal(
      observed.outcomes()[0]!.turn,
      native.control.compactTurn,
    )
    assert.deepEqual(
      observed.outcomes()[0]!.inputIds,
      ['compact'],
    )
  },
)

test(
  'a Claude transport failure retains consumed input IDs and leaves its queued input uncertain',
  async t => {
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const input = inbox()
    const observed = observe({
      session,
      input,
    })
    t.after(() => {
      input.end(); session.close()
    })
    input.push({
      id: 'consumed',
      text: 'Work',
    })
    input.push({
      id: 'queued',
      text: 'Later',
    })
    await until({
      what: 'the native sends',
      check: () => native.incoming.length === 2,
    })
    const assistant = claudeRecording.turn.find(message => message.type === 'assistant')
    assert.ok(assistant?.type === 'assistant')
    native.send({
      message: {
        ...assistant,
        user_message_uuid: native.incoming[0]!.uuid,
      },
    })
    await until({
      what: 'the native assistant output',
      check: () => observed.events.some(event => typeof event === 'object' && event.type === 'text'),
    })
    const failure = assert.rejects(
      observed.done,
      /native transport failed/,
    )
    native.fail({ error: new Error('native transport failed') })
    await failure
    assert.deepEqual(
      session.snapshot().outcome?.inputIds,
      ['consumed'],
    )
    assert.equal(
      session.snapshot().outcome?.status,
      'failed',
    )
    assert.deepEqual(
      session.snapshot().work.unsettledInputs,
      [
        'consumed',
        'queued',
      ],
    )
    assert.equal(
      nativeIdle({ work: session.snapshot().work }),
      false,
    )
  },
)

test(
  'detaching a Claude reader preserves native execution and a complete terminal result for the next reader',
  async t => {
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const input = inbox()

    const messages = async function* () {
      for await (const message of input) {
        yield {
          id: message.id!,
          text: message.text,
          images: [],
        }
      }
    }

    const reader = session.run({
      input: messages(),
      permission,
    })[Symbol.asyncIterator]()
    t.after(() => {
      input.end(); session.close()
    })
    input.push({
      id: 'message',
      text: 'Hello',
    })
    await until({
      what: 'the native input',
      check: () => native.incoming.length === 1,
    })
    await reader.return!()
    assert.equal(
      native.closed(),
      false,
    )
    const attached = session.attach()[Symbol.asyncIterator]()
    native.send({
      message: terminal({
        input: native.incoming[0]!.uuid,
        text: '{"outcomes":[]}',
      }),
    })
    let outcome: TurnOutcome | undefined

    for await (const event of { [Symbol.asyncIterator]: () => attached }) {
      if (typeof event === 'object' && event.type === 'turn-ended') {
        outcome = event.outcome
        break
      }
    }

    assert.equal(
      outcome?.result,
      '{"outcomes":[]}',
    )
    assert.deepEqual(
      outcome?.inputIds,
      ['message'],
    )
    assert.deepEqual(
      session.snapshot().outcome,
      outcome,
    )
    assert.equal(
      eventClass({
        event: {
          type: 'turn-ended',
          outcome: outcome!,
        },
      }),
      'critical',
    )
    assert.equal(
      eventClass({
        event: {
          type: 'text',
          id: 'text',
          text: 'delta',
        },
      }),
      'view',
    )
    session.close()
    assert.equal(
      native.closed(),
      true,
    )
  },
)

test(
  'a native permission keeps its identity through answer submission without retaining secret values in receipts',
  async t => {
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const input = inbox()
    let allow = () => {}
    const decision = new Promise<void>(resolve => {
      allow = resolve
    })
    const observed = observe({
      session,
      input,
      ask: async () => {
        await decision

        return {
          behavior: 'allow',
          answers: [['secret-value']],
        }
      },
    })
    t.after(async () => {
      allow(); input.end(); session.close(); await observed.done
    })
    input.push({
      id: 'input',
      text: 'Ask a question',
    })
    await until({
      what: 'the native query to start',
      check: () => native.incoming.length === 1,
    })
    const answer = native.ask({
      id: 'native-request',
      input: {
        questions: [
          {
            question: 'Password?',
            header: 'Password',
            options: [{ label: 'Enter a password' }],
          },
        ],
      },
    })
    await until({
      what: 'the native permission inventory',
      check: () => session.snapshot().permissions.length === 1,
    })
    assert.equal(
      session.snapshot().permissions[0]!.id,
      'native-request',
    )
    assert.deepEqual(
      session.snapshot().work.pendingControls,
      ['native-request'],
    )
    allow()
    assert.deepEqual(
      await answer,
      {
        behavior: 'allow',
        updatedInput: {
          questions: [
            {
              question: 'Password?',
              header: 'Password',
              options: [{ label: 'Enter a password' }],
            },
          ],
          answers: { 'Password?': 'secret-value' },
        },
      },
    )
    assert.equal(
      session.snapshot().answers[0]!.permission,
      'native-request',
    )
    assert.equal(
      session.snapshot().answers[0]!.phase,
      'submitted',
    )
    assert.deepEqual(
      session.snapshot().permissions,
      [],
    )
    assert.deepEqual(
      session.snapshot().work.pendingControls,
      [],
    )
    assert.equal(
      JSON.stringify(session.snapshot()).includes('secret-value'),
      false,
    )
    await until({
      what: 'the answer receipts',
      check: () => observed.events.some(event => typeof event === 'object' && event.type === 'answer' && event.receipt.phase === 'submitted'),
    })
    const phases = observed.events.flatMap(event => typeof event === 'object' && event.type === 'answer' ? [event.receipt.phase] : [])
    assert.deepEqual(
      phases,
      [
        'received',
        'submitted',
      ],
    )
  },
)

test(
  'a Claude terminal outcome retains structured output and final text independently of streamed text',
  async t => {
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const input = inbox()
    const observed = observe({
      session,
      input,
    })
    t.after(async () => {
      input.end(); session.close(); await observed.done
    })
    input.push({
      id: 'batch',
      text: 'Return outcomes',
    })
    await until({
      what: 'the helper input',
      check: () => native.incoming.length === 1,
    })
    const completed = terminal({
      input: native.incoming[0]!.uuid,
      text: 'Fallback result',
    })
    assert.ok(completed.type === 'result' && completed.subtype === 'success')
    native.send({
      message: {
        ...completed,
        structured_output: {
          outcomes: [
            {
              task: 'task',
              audience: 'routine',
              summary: 'Done',
            },
          ],
        },
      },
    })
    await until({
      what: 'the complete terminal result',
      check: () => observed.outcomes().length === 1,
    })
    const outcome = observed.outcomes()[0]!
    assert.deepEqual(
      outcome.structured,
      {
        outcomes: [
          {
            task: 'task',
            audience: 'routine',
            summary: 'Done',
          },
        ],
      },
    )
    assert.equal(
      outcome.result,
      'Fallback result',
    )
    assert.equal(
      outcome.status,
      'completed',
    )
    assert.equal(
      outcome.usage?.cost,
      completed.total_cost_usd,
    )
    assert.ok(Number.isFinite(Date.parse(outcome.at)))
    assert.equal(
      eventClass({
        event: {
          type: 'turn-ended',
          outcome,
        },
      }),
      'critical',
    )
  },
)

test(
  'a rejected permission handler leaves a failed receipt and removes the native pending control',
  async t => {
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const input = inbox()
    const observed = observe({
      session,
      input,
      ask: async () => {
        throw new Error('permission policy failed')
      },
    })
    t.after(async () => {
      input.end(); session.close(); await observed.done
    })
    input.push({
      id: 'input',
      text: 'Ask',
    })
    await until({
      what: 'the native query',
      check: () => native.incoming.length === 1,
    })
    await assert.rejects(
      native.ask({
        id: 'failed-request',
        input: {},
      }),
      /permission policy failed/,
    )
    assert.deepEqual(
      session.snapshot().permissions,
      [],
    )
    assert.deepEqual(
      session.snapshot().work.pendingControls,
      [],
    )
    assert.equal(
      session.snapshot().answers[0]!.phase,
      'failed',
    )
    await until({
      what: 'permission-ended after policy failure',
      check: () => observed.events.some(event => typeof event === 'object' && event.type === 'permission-ended' && event.id === 'failed-request'),
    })
  },
)

test(
  'application-selected images exclude context paths and fail visibly if bytes change before native delivery',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-native-image-',
    ))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const attachments = join(
      root,
      'hydras',
      'fixture',
      'attachments',
    )
    mkdirSync(
      attachments,
      { recursive: true },
    )
    const image = join(
      attachments,
      `${randomUUID()}.png`,
    )
    const contextImage = join(
      attachments,
      `${randomUUID()}.png`,
    )
    writeFileSync(
      image,
      'original',
    )
    writeFileSync(
      contextImage,
      'context',
    )
    const message = agentInput({
      id: 'message',
      original: `[image: ${image}]`,
      text: `[image: ${contextImage}]\nLook at [image: ${image}]`,
      hydras: join(
        root,
        'hydras',
      ),
    })
    assert.deepEqual(
      message.images.map(part => part.path),
      [image],
    )
    writeFileSync(
      image,
      'changed',
    )
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: root,
      env: {},
      settings: {},
      signal: new AbortController().signal,
    })
    t.after(() => session.close())

    const delivered: HostedEvent[] = []

    const read = async () => {
      for await (const event of session.run({
        input: (async function* () {
          yield message
        })(),
        permission,
      })) {
        delivered.push(event)
      }
    }

    await assert.rejects(
      read(),
      /attached image changed before delivery/,
    )
    assert.ok(delivered.some(event => typeof event === 'object' && event.type === 'ended' && event.reason === 'failed'))
    assert.equal(
      native.incoming.length,
      0,
    )
  },
)

test(
  'a slow event reader fails without stopping native execution or losing the terminal snapshot',
  async t => {
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    t.after(() => session.close())
    const reader = session.run({
      input: (async function* () {
        yield {
          id: 'input',
          text: 'Stream',
          images: [],
        }
      })(),
      permission,
    })[Symbol.asyncIterator]()
    await until({
      what: 'the native input',
      check: () => native.incoming.length === 1,
    })
    const assistant = claudeRecording.turn.find(message => message.type === 'assistant')
    assert.ok(assistant?.type === 'assistant')
    const FLOOD_EVENTS = 10_000

    for (let sent = 0; sent < FLOOD_EVENTS; sent++) {
      native.send({
        message: {
          ...assistant,
          user_message_uuid: undefined,
          user_message_uuids: undefined,
        },
      })
    }

    native.send({
      message: terminal({
        input: native.incoming[0]!.uuid,
        text: 'Retained terminal result',
      }),
    })
    await until({
      what: 'the terminal result after reader overflow',
      check: () => session.snapshot().outcome?.result === 'Retained terminal result',
    })
    await assert.rejects(
      reader.next(),
      /reader fell behind/,
    )
    assert.equal(
      native.closed(),
      false,
    )
    assert.equal(
      session.snapshot().outcome?.status,
      'completed',
    )
    await reader.return!()
  },
)

test(
  'a result-only Claude turn without input echoes cannot inherit prior assistant or structured output',
  async t => {
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const input = inbox()
    const observed = observe({
      session,
      input,
    })
    t.after(async () => {
      input.end(); session.close(); await observed.done
    })
    input.push({
      id: 'first',
      text: 'First',
    })
    await until({
      what: 'first input',
      check: () => native.incoming.length === 1,
    })
    const first = terminal({
      input: native.incoming[0]!.uuid,
      text: 'First result',
    })
    assert.ok(first.type === 'result' && first.subtype === 'success')
    const assistant = claudeRecording.turn.find(message => message.type === 'assistant')
    assert.ok(assistant?.type === 'assistant')
    native.send({
      message: {
        ...assistant,
        uuid: randomUUID(),
        user_message_uuid: native.incoming[0]!.uuid,
        message: {
          ...assistant.message,
          id: 'first-assistant',
          content: [
            {
              type: 'text',
              text: 'First turn text',
              citations: [],
            },
          ],
        },
      },
    })
    native.send({
      message: {
        ...first,
        structured_output: { first: true },
      },
    })
    await until({
      what: 'first outcome',
      check: () => observed.outcomes().length === 1,
    })
    const saved = structuredClone(observed.outcomes()[0]!)
    assert.deepEqual(
      saved.structured,
      { first: true },
    )
    assert.equal(
      saved.assistant[0]?.text,
      'First turn text',
    )
    input.push({
      id: 'second',
      text: '/cost',
    })
    await until({
      what: 'second input',
      check: () => native.incoming.length === 2,
    })
    const second = terminal({ text: 'Second result' })
    assert.ok(second.type === 'result' && second.subtype === 'success')
    delete second.user_message_uuid
    delete second.user_message_uuids
    delete second.structured_output
    native.send({ message: second })
    await until({
      what: 'second outcome',
      check: () => observed.outcomes().length === 2,
    })
    const outcome = observed.outcomes()[1]!
    assert.notEqual(
      outcome.turn,
      saved.turn,
    )
    assert.equal(
      outcome.result,
      'Second result',
    )
    assert.deepEqual(
      outcome.assistant,
      [],
    )
    assert.equal(
      outcome.structured,
      undefined,
    )
    assert.deepEqual(
      session.snapshot().outcome,
      outcome,
    )
    assert.deepEqual(
      observed.outcomes()[0],
      saved,
    )
  },
)
