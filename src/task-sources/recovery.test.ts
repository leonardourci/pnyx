import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { until } from '#test-harness/harness.ts'
import { decidePush } from '#tasks/push.ts'
import { enqueueSteering } from '#workers/inbox.ts'
import { decideSession } from '#workers/sessions.ts'
import { createSourceRunner } from './runner.ts'
import { captureResult } from './sources.ts'

test(
  'source recovery delivers the original instruction queued before a template change',
  async t => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-source-recovery-',
    )))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const folder = join(
      root,
      'work',
    )
    mkdirSync(folder)
    await commands.hydra([
      'create',
      'lab',
    ])
    await commands.task([
      'create',
      '--title',
      'Watch a job',
      '--key',
      'work',
      '--hydra',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const id = state().keys.work!
    const meta = {
      actor: 'test',
      at: new Date().toISOString(),
    }
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const pushed = decidePush({
          state: writer.state,
          newCardId: `c${writer.state.seq + 1}`,
          key: 'worker',
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'worker',
              cwd: folder,
            },
            terminal: { tty: '/dev/ttys123' },
            activity: 'finished',
          },
          meta,
        })
        assert.ok('event' in pushed)
        writer.append({ event: pushed.event })
        const attached = decideSession({
          state: writer.state,
          ref: 'claude-code:worker',
          task: id,
          meta,
        })
        assert.ok('event' in attached)
        writer.append({ event: attached.event })
      },
    })
    await commands.task([
      'source',
      'register',
      id,
      'job',
      '--hydra',
      'lab',
      '--executable',
      process.execPath,
      '--argv',
      '[]',
      '--cwd',
      folder,
    ])
    const originalText = 'An external job finished. Instructions from the previous version.'
    const messageId = withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const card = writer.state.cards[id]!
        const source = card.externalSources![0]!
        captureResult({
          writer,
          card,
          source,
          run: 'previous-run',
          outcome: 'completed',
          stdout: 'result',
          detail: 'done',
          meta,
        })
        const result = writer.state.cards[id]!.externalSources![0]!.results[0]!
        enqueueSteering({
          writer,
          ref: id,
          id: result.message,
          text: originalText,
          source: `external:${source.registration}`,
          meta,
        })

        return result.message
      },
    })
    const errors: string[] = []
    t.mock.method(
      console,
      'error',
      // eslint-disable-next-line pnyx/object-params -- Console owns error's signature.
      (message: unknown) => errors.push(String(message)),
    )
    const notifications: string[] = []
    const runner = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      state,
      tell: async ({ request }) => {
        assert.ok(request.text)
        notifications.push(request.text)

        return { state: 'delivered' }
      },
    })
    t.after(() => runner.close())
    runner.reconcile()
    await until({
      what: 'source recovery notification',
      check: () => notifications.length > 0 || errors.length > 0,
    })
    await runner.close()
    assert.deepEqual(
      errors,
      [],
    )
    assert.equal(
      notifications.length,
      1,
    )
    const message = state().cards[id]!.steering!.find(message => message.id === messageId)!
    assert.equal(
      message.text,
      originalText,
    )
    assert.equal(
      message.attempts[0]?.result,
      'delivered',
    )
    assert.equal(
      state().cards[id]!.externalSources![0]!.results[0]!.handled,
      undefined,
    )
  },
)
