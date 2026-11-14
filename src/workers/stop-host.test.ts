import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reply as replyCommand } from '#workers/reply-cli.ts'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { hostRequest } from '#app/host-request.ts'
import { offerHost } from '#app/server-state.ts'
import { holdHydra, loadHydra, reloadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { decidePush } from '#tasks/push.ts'
import { applyDecision } from '#app/decision.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { fakeDispatch } from '#test-harness/dispatch-fixture.ts'
import { until } from '#test-harness/harness.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'

test(
  'owner messages reuse a busy Hydra despite legacy Fast, deny pending permissions, and Stop records cancellation',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-stop-host-',
    ))
    const previousHome = process.env.PNYX_HOME
    const previousPath = process.env.PATH
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    fakeDispatch({ root })
    const hydraId = 'stop-host'
    await commands.hydra([
      'create',
      hydraId,
    ])
    const releaseHydra = holdHydra({
      hydraId,
      changed: () => {},
    })
    const native = claudeNative()
    let selected = native
    const host = createHost({
      hydraId,
      query: ({ ...request }) => selected.query(request),
      changed: () => {},
    })
    const unoffer = offerHost({
      hydraId,
      ask: ({ body }) => hostRequest({
        host,
        body,
      }),
    })
    t.after(() => {
      host.close(); unoffer(); releaseHydra()
      process.env.PNYX_HOME = previousHome
      process.env.PATH = previousPath
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const state = () => loadHydra({ hydraId }).state

    const send = async ({
      text,
      id,
    }: {
      text: string
      id: string
    }) => {
      await commands.hydra([
        'send',
        '--text',
        text,
        '--event-id',
        id,
        '--hydra',
        hydraId,
      ])

      return hostRequest({
        host,
        body: {
          action: 'hydra',
          text,
          id,
          actor: 'web',
        },
      })
    }

    await commands.hydra([
      'send',
      '--text',
      'Cancel before opening',
      '--event-id',
      'before-open',
      '--hydra',
      hydraId,
    ])
    const opening = host.hydra({
      text: 'Cancel before opening',
      id: 'before-open',
      actor: 'web',
    })
    await hostRequest({
      host,
      body: {
        action: 'stop',
        actor: 'web',
      },
    })
    await opening
    assert.equal(
      state().hydraMessages?.find(message => message.id === 'before-open')?.stopped,
      true,
    )

    await send({
      text: 'Start this turn',
      id: 'open',
    })
    await until({
      what: 'Hydra opening input',
      check: () => native.incoming.length === 1,
    })
    withWriter({
      hydraId,
      fn: ({ writer }) => applyDecision({
        writer,
        decision: decidePush({
          state: writer.state,
          key: HYDRA_CARD,
          input: { settings: { fast: 'off' } },
          meta: {
            at: new Date().toISOString(),
            actor: 'pnyx',
          },
        }),
      }),
    })
    const permission = native.ask({
      id: 'question',
      input: {
        questions: [
          {
            question: 'Proceed?',
            header: 'Proceed',
            options: [
              {
                label: 'Yes',
                description: 'Proceed',
              },
            ],
          },
        ],
      },
    })
    await until({
      what: 'pending permission',
      check: () => state().cards[HYDRA_CARD]?.permissions?.some(request => request.status === 'pending'),
    })
    await send({
      text: 'Change course instead',
      id: 'join',
    })
    assert.deepEqual(
      await permission,
      {
        behavior: 'deny',
        message: 'The owner answered with a message instead of approving. Their message follows: Change course instead',
      },
    )
    await until({
      what: 'message joins the busy session',
      check: () => native.incoming.length === 2,
    })
    assert.equal(
      native.closed(),
      false,
    )
    native.cancelled.push(native.incoming[1]!.uuid!)
    await hostRequest({
      host,
      body: {
        action: 'stop',
        actor: 'web',
      },
    })
    assert.equal(
      state().cards[HYDRA_CARD]?.sessionActivity,
      'interrupted',
    )
    assert.equal(
      state().hydraMessages?.find(message => message.id === 'join')?.stopped,
      true,
    )
    assert.deepEqual(
      native.interrupts.at(-1),
      { cancelQueued: true },
    )
    reloadHydra({ hydraId })
    assert.equal(
      state().hydraMessages?.find(message => message.id === 'join')?.stopped,
      true,
    )
    assert.equal(
      state().cards[HYDRA_CARD]?.permissions?.find(request => request.nativeId === 'question')?.status,
      'deny',
    )
    await commands.task([
      'create',
      '--title',
      'Synthetic worker',
      '--hydra',
      hydraId,
    ])
    const worker = Object.values(state().cards).find(card => card.title === 'Synthetic worker')!
    selected = claudeNative()
    await host.start({
      task: worker.id,
      prompt: 'Work on the task',
      folder: root,
      settings: {},
      id: 'worker-start',
      actor: 'web',
      reason: 'Exercise worker Stop',
    })
    await until({
      what: 'worker input',
      check: () => selected.incoming.length === 1,
    })
    const workerPermission = selected.ask({
      id: 'worker-question',
      input: {
        questions: [
          {
            question: 'Approve?',
            header: 'Approve',
            options: [
              {
                label: 'Yes',
                description: 'Proceed',
              },
            ],
          },
        ],
      },
    })
    await until({
      what: 'worker permission',
      check: () => state().cards[worker.id]?.permissions?.some(request => request.status === 'pending'),
    })
    await replyCommand([
      worker.id,
      '--text',
      'Change worker course',
      '--actor',
      'web',
      '--hydra',
      hydraId,
    ])
    const workerAnswer = await workerPermission
    assert.ok(workerAnswer)
    assert.equal(
      workerAnswer.behavior,
      'deny',
    )
    await until({
      what: 'worker queued message',
      check: () => selected.incoming.length === 2,
    })
    selected.cancelled.push(selected.incoming[1]!.uuid!)
    await commands.task([
      'stop',
      worker.id,
      '--hydra',
      hydraId,
    ])
    assert.deepEqual(
      selected.interrupts.at(-1),
      { cancelQueued: true },
    )
    assert.equal(
      state().cards[worker.id]?.sessionActivity,
      'interrupted',
    )
    reloadHydra({ hydraId })
    const cancelled = state().cards[worker.id]?.steering?.find(message => message.text.includes('Change worker course'))
    assert.equal(
      cancelled?.cancelled,
      true,
    )
    const reply = state().cards[worker.id]?.replies?.find(reply => reply.id === cancelled?.reply)
    assert.equal(
      reply?.state,
      'failed',
    )
    assert.equal(
      reply?.detail,
      'stopped',
    )
  },
)
