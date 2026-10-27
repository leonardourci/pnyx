import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { HYDRA_CARD, hydraEvent } from '../../src/core/hydra.ts'
import { withWriter } from '../../src/store/hydra-store.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'a failed snapshot write during a helper grant is contained without killing the daemon or losing the batch',
  async t => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
      ],
    })
    await s.chat({ text: 'Keep routine progress quiet.' })
    await until({
      what: 'main to finish',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          cardId: HYDRA_CARD,
          meta: {
            at: new Date().toISOString(),
            actor: 'web',
          },
          change: {
            type: 'board.configured',
            data: {
              ...writer.state.config!,
              helper: {
                harness: 'claude',
                model: 'sonnet',
              },
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const task = s.task({ key: 'work' })
    pnyx.claude.plan({
      text: '',
      reply: JSON.stringify({
        outcomes: [
          {
            task: task.id,
            audience: 'routine',
            summary: 'Progress checked.',
          },
        ],
      }),
    })
    let blocked = false
    const errors = t.mock.method(
      console,
      'error',
      () => {},
    )
    const rename = fs.renameSync
    t.mock.method(
      fs,
      'renameSync',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.renameSync's signature.
      (...args: Parameters<typeof fs.renameSync>) => {
        if (!blocked && String(args[1]).endsWith('/snapshot.json')
          && new Error().stack?.includes('/helper/runner.ts') && Object.keys(s.state().helper?.runs ?? {}).length > 0) {
          blocked = true
          throw Object.assign(
            new Error('snapshot replace failed'),
            { code: 'EIO' },
          )
        }

        return rename(...args)
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll(); syncBuiltinESMExports()
    })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          cardId: HYDRA_CARD,
          meta: {
            at: new Date().toISOString(),
            actor: `worker:${task.id}`,
          },
          change: {
            type: 'hydra.message',
            data: {
              action: 'send',
              hydra: 'hydra',
              task: task.id,
              kind: 'progress',
              text: 'Progress through a busy writer.',
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    await until({
      what: 'the helper outcome to persist',
      check: () => s.state().helper?.outcomes.some(outcome => outcome.task === task.id && outcome.summary === 'Progress checked.'),
    })
    await until({
      what: 'the helper lease to release',
      check: () => !fs.existsSync(`${process.env.PNYX_HOME}/hydras/${s.hydraId}/helper-lease-${encodeURIComponent(task.id)}.json`),
    })
    assert.ok(blocked)
    assert.equal(
      s.events().filter(event => event.type === 'hydra.helper-started').length,
      1,
    )
    const grants = s.events().filter(event => event.type === 'hydra.helper-started')
    const finishes = s.events().filter(event => event.type === 'hydra.helper-finished')
    assert.equal(
      finishes.length,
      1,
    )
    assert.equal(
      finishes[0]!.data.batch,
      grants[0]!.data.id,
    )
    const progress = s.events().find(event => event.type === 'hydra.message' && event.data.text === 'Progress through a busy writer.')!
    assert.ok(grants[0]!.data.seqs.includes(progress.seq))
    assert.ok(errors.mock.calls.some(call => call.arguments.join(' ').includes('snapshot replace failed')))
    assert.equal(
      (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status,
      200,
    )
  },
)
