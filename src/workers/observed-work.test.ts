import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { startServer } from '#app/server-daemon.ts'
import { loadHydra } from '#app/store.ts'
import { localToken } from '#app/server-state.ts'
import type { RunningServer, ServerMessage } from '#app/server-transport.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import { until } from '#test-harness/harness.ts'

const QUIET_MS = 3_600_000

test(
  'native tool and background changes reach the page without transcript writes',
  async t => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-observed-work-',
    ))
    process.env.PNYX_HOME = home
    const resources: {
      server?: RunningServer
      ws?: WebSocket
    } = {}
    t.after(async () => {
      resources.ws?.close()
      await resources.server?.close()
      process.env.PNYX_HOME = previous
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const native = claudeNative()
    const server = await startServer({
      query: native.query,
      wakeDelay: QUIET_MS,
      stallDelay: QUIET_MS,
      busyDelay: QUIET_MS,
    })
    resources.server = server
    const token = localToken()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/default/ws?token=${token}`)
    resources.ws = ws
    let action: CurrentAction | null | undefined
    ws.on(
      'message',
      bytes => {
        const message = JSON.parse(String(bytes)) as ServerMessage

        if (message.type === 'latest' && HYDRA_CARD in message.actions) {
          action = message.actions[HYDRA_CARD]
        }
      },
    )
    await new Promise((
      resolve,
      reject,
    ) => {
      ws.once(
        'open',
        resolve,
      ); ws.once(
        'error',
        reject,
      )
    })
    const response = await fetch(
      `http://127.0.0.1:${server.port}/hydra/default/host`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'hydra',
          text: 'Synthetic work',
          id: randomUUID(),
          actor: 'cli',
        }),
      },
    )
    assert.equal(
      response.status,
      200,
    )
    await until({
      what: 'native input',
      check: () => native.incoming.length === 1,
    })
    const assistant = claudeRecording.turn.find(message => message.type === 'assistant')
    const result = claudeRecording.turn.find(message => message.type === 'result')
    assert.ok(assistant?.type === 'assistant')
    assert.ok(result?.type === 'result')
    native.send({
      message: {
        ...assistant,
        uuid: randomUUID(),
        message: {
          ...assistant.message,
          content: [
            {
              type: 'tool_use',
              id: 'shell',
              name: 'Bash',
              input: { command: 'synthetic-command' },
            },
          ],
        },
      },
    })
    await until({
      what: 'running tool on WebSocket',
      check: () => action?.work?.runningTools.includes('shell'),
    })
    assert.equal(
      action?.calls[0]?.tool,
      'Bash',
    )
    const path = loadHydra({ hydraId: 'default' }).state.cards[HYDRA_CARD]?.agent?.transcriptPath
    assert.ok(path)
    mkdirSync(
      dirname(path),
      { recursive: true },
    )
    const at = '2026-10-29T12:00:00Z'
    writeFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        timestamp: at,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'shell',
              name: 'exec_command',
              input: { cmd: 'pwd' },
            },
          ],
        },
      }) + '\n',
    )
    await until({
      what: 'transcript metadata on the native action',
      check: () => action?.calls[0]?.tool === 'exec_command',
    })
    assert.equal(
      action?.calls[0]?.command,
      'pwd',
    )
    assert.equal(
      action?.at,
      at,
    )

    native.send({
      message: {
        type: 'user',
        uuid: randomUUID(),
        session_id: 'native',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'shell',
              content: 'Done',
            },
          ],
        },
      },
    })
    native.send({
      message: {
        type: 'system',
        subtype: 'background_tasks_changed',
        uuid: randomUUID(),
        session_id: 'native',
        tasks: [
          {
            task_id: 'job',
            task_type: 'shell',
            description: 'Synthetic background work',
          },
        ],
      },
    })
    native.send({
      message: {
        ...result,
        uuid: randomUUID(),
        user_message_uuid: native.incoming[0]!.uuid,
        queued_turn_count: 0,
      },
    })
    await until({
      what: 'background-only work on WebSocket',
      check: () => action?.work?.background.knowledge === 'known'
    && action.work.background.tasks.length === 1
    && action.work.runningTools.length === 0 && action.work.runningTurns.length === 0,
    })
    assert.deepEqual(
      action?.calls,
      [],
    )
    native.send({
      message: {
        type: 'system',
        subtype: 'background_tasks_changed',
        uuid: randomUUID(),
        session_id: 'native',
        tasks: [],
      },
    })
    const unknownQueue = {
      ...result,
      uuid: randomUUID(),
    }
    delete unknownQueue.queued_turn_count
    native.send({ message: unknownQueue })
    await until({
      what: 'unknown queue on WebSocket',
      check: () => action?.work?.queue.knowledge === 'unknown',
    })
    assert.equal(
      action?.done,
      false,
    )
    native.send({
      message: {
        ...result,
        uuid: randomUUID(),
        queued_turn_count: 0,
      },
    })
    await until({
      what: 'settled native work on WebSocket',
      check: () => action?.done,
    })
    assert.equal(
      action?.work?.background.knowledge,
      'known',
    )
    assert.deepEqual(
      action?.work?.runningTools,
      [],
    )
  },
)
