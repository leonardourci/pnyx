import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { readEvents } from '#app/event-log.ts'
import type { NativeHealth } from './health.ts'
import { createDiagnosticRecovery } from './recovery.ts'
import type { RecoveryAttempt } from './recovery-state.ts'

test(
  'a temporary lease delays recovery without a stop notice, while exhaustion still notifies under that lease',
  async t => {
    const previous = process.env.PNYX_HOME
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-recovery-notice-',
    ))
    process.env.PNYX_HOME = root
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await commands.hydra([
      'create',
      'lab',
    ])
    await commands.task([
      'create',
      '--key',
      'work',
      '--title',
      'Work',
      '--hydra',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const task = state().keys.work!
    const sessionId = 'codex:synthetic'
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const card = writer.state.cards[task]!
        card.agent = {
          provider: 'codex',
          sessionId: 'synthetic',
          host: 'pnyx',
        }
        card.sessionIds = [sessionId]
        card.steeringGeneration = 1

        for (const status of [
          'queued',
          'failed',
        ] as const) {
          writer.append({
            event: {
              v: 1,
              seq: writer.state.seq + 1,
              id: `original-${status}`,
              at: new Date().toISOString(),
              actor: 'cli',
              cardId: task,
              sessionId,
              type: 'card.replied',
              data: {
                reply: 'message',
                route: 'pnyx',
                state: status,
                text: 'Synthetic instruction',
              },
            },
          })
        }
      },
    })
    const record = ({ number }: { number: number }) => withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const attempt: RecoveryAttempt = {
          message: 'message',
          number,
          status: 'failed',
          sessionId,
          generation: 1,
          at: new Date().toISOString(),
        }
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: `failed-${number}`,
            at: attempt.at,
            actor: 'pnyx',
            cardId: task,
            type: 'diagnostic.retry',
            data: attempt,
          },
        })
      },
    })
    const native: NativeHealth = {
      sessionId,
      taskId: task,
      attached: true,
      generation: 1,
      leased: true,
      inputs: [],
      work: {
        runningTurns: [],
        runningTools: [],
        unsettledInputs: [],
        pendingControls: [],
        queue: {
          knowledge: 'known',
          count: 0,
        },
        background: {
          knowledge: 'known',
          tasks: [],
        },
      },
    }
    const create = () => createDiagnosticRecovery({
      hydraId: 'lab',
      sessions: () => [native],
      enabled: () => true,
      changed: () => {},
      pause: 60_000,
    })
    const notices = () => readEvents({ hydraId: 'lab' }).filter(event => event.type === 'hydra.message' && event.messageId === 'message')
    record({ number: 1 })
    const delayed = create()
    t.after(delayed.close)
    assert.deepEqual(
      delayed.originals().map(event => event.id),
      ['original-queued'],
    )
    delayed.reconcile()
    assert.equal(
      notices().length,
      0,
    )
    native.leased = false
    delayed.reconcile()
    assert.equal(
      notices().length,
      0,
    )
    await delayed.close()
    native.leased = true
    record({ number: 2 })
    const exhausted = create()
    t.after(exhausted.close)
    exhausted.reconcile()
    exhausted.reconcile()
    assert.equal(
      notices().length,
      1,
    )
  },
)
