import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { HYDRA_CARD, hydraEvent } from '../../src/core/hydra.ts'
import { HydraError } from '../../src/core/model.ts'
import { localToken } from '../../src/server/state.ts'
import { withWriter } from '../../src/store/hydra-store.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

for (const phase of [
  'grant',
  'finish',
  'release',
]) {
  test(
    `a busy writer during helper ${phase} is deferred without killing the daemon or losing the batch`,
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
      const original = fs.openSync
      let blocked = false
      const errors = t.mock.method(
        console,
        'error',
        () => {},
      )
      t.mock.method(
        fs,
        'openSync',
        // eslint-disable-next-line pnyx/object-params -- Node owns fs.openSync's signature.
        (...args: Parameters<typeof fs.openSync>) => {
          if (!String(args[0]).endsWith('/writer.lock')) {
            return original(...args)
          }

          const stack = new Error().stack ?? ''
          const started = Object.keys(s.state().helper?.runs ?? {}).length > 0
          const finished = s.state().helper?.outcomes.some(outcome => outcome.task === task.id)
          const target = phase === 'grant' ? !started && stack.includes('/helper/runner.ts')
            : phase === 'finish' ? started && stack.includes('at append ')
              : finished && stack.includes('/helper/leases.ts')

          if (!blocked && target) {
            blocked = true
            throw new HydraError({
              message: 'writer is busy',
              code: 'LOCKED',
            })
          }

          return original(...args)
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
      assert.ok(errors.mock.calls.some(call => call.arguments.join(' ').includes('writer is busy')))
      assert.equal(
        (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status,
        200,
      )
    },
  )
}

for (const failure of [
  'synchronous',
  'asynchronous',
]) {
  test(
    `${failure} EMFILE degrades watchers and preserves server events and transcript updates`,
    async t => {
      const original = fs.watch
      const errors = t.mock.method(
        console,
        'error',
        () => {},
      )
      t.mock.method(
        fs,
        'watch',
        // eslint-disable-next-line pnyx/object-params -- Node owns fs.watch's signature.
        (...args: Parameters<typeof fs.watch>) => {
          const error = Object.assign(
            new Error('watch limit reached'),
            { code: 'EMFILE' },
          )

          if (failure === 'synchronous') {
            throw error
          }

          const watcher = Reflect.apply(
            original,
            fs,
            args,
          ) as fs.FSWatcher
          setImmediate(() => watcher.emit(
            'error',
            error,
          ))

          return watcher
        },
      )
      syncBuiltinESMExports()
      t.after(() => {
        t.mock.restoreAll(); syncBuiltinESMExports()
      })
      const s = await pnyx.scenario()
      const folder = s.folder({ name: 'worker' })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'work',
          '--title',
          'Work',
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'start',
          'work',
          '--harness',
          'claude',
        ],
      })
      await until({
        what: 'the worker to finish',
        check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
      })
      const card = s.task({ key: 'work' })
      const ws = new WebSocket(`ws://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/ws?token=${localToken()}`)
      let latest = ''
      ws.on(
        'message',
        data => {
          const message = JSON.parse(String(data))

          if (message.type === 'latest' && message.messages[card.id]) {
            latest = message.messages[card.id].text
          }
        },
      )
      await once(
        ws,
        'open',
      )
      t.after(() => ws.close())
      ws.send(JSON.stringify({
        type: 'command',
        id: 'thread',
        name: 'thread',
        args: [card.id],
      }))
      await until({
        what: 'the current transcript',
        check: () => latest.length > 0,
      })
      fs.appendFileSync(
        card.agent!.transcriptPath!,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Transcript after watcher failure.',
              },
            ],
          },
        })}\n`,
      )
      await until({
        what: 'stat polling to deliver the edited transcript',
        check: () => latest === 'Transcript after watcher failure.',
      })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'later',
          '--title',
          'After watcher failure',
        ],
      })
      assert.equal(
        s.task({ key: 'later' }).title,
        'After watcher failure',
      )
      assert.ok(errors.mock.calls.some(call => call.arguments.join(' ').includes('watch limit reached')))
      assert.equal(
        (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status,
        200,
      )
    },
  )
}
