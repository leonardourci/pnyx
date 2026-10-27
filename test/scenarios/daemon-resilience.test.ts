import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { HYDRA_CARD, hydraEvent } from '../../src/core/hydra.ts'
import { join } from 'node:path'
import { localToken } from '../../src/server/state.ts'
import { spoolWrite, withWriter } from '../../src/store/hydra-store.ts'
import { scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()

for (const phase of [
  'grant',
  'grant-error',
  'grant-committed',
  'finish',
  'error',
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
        fail: phase === 'error' ? 'helper provider failed' : undefined,
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
      let unlock: ReturnType<typeof setTimeout> | undefined
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
          let target = phase === 'release' && finished && stack.includes('/helper/leases.ts')

          if (phase === 'grant' || phase === 'grant-error') {
            target = !started && stack.includes('/helper/runner.ts')
          } else if (phase === 'finish' || phase === 'error') {
            target = started && stack.includes('at append ')
          }

          if (!blocked && target) {
            blocked = true

            if (phase === 'grant-error') {
              throw Object.assign(
                new Error('grant write failed'),
                { code: 'EIO' },
              )
            }

            fs.writeFileSync(
              String(args[0]),
              String(process.pid),
            )
            unlock = setTimeout(
              () => fs.rmSync(
                String(args[0]),
                { force: true },
              ),
              100,
            )
          }

          return original(...args)
        },
      )
      const rename = fs.renameSync
      t.mock.method(
        fs,
        'renameSync',
        // eslint-disable-next-line pnyx/object-params -- Node owns fs.renameSync's signature.
        (...args: Parameters<typeof fs.renameSync>) => {
          if (phase === 'grant-committed' && !blocked && String(args[1]).endsWith('/snapshot.json')
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
        clearTimeout(unlock)
        fs.rmSync(
          join(
            process.env.PNYX_HOME!,
            'hydras',
            s.hydraId,
            'writer.lock',
          ),
          { force: true },
        )
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
        check: () => phase === 'error'
          ? s.events().some(event => event.type === 'hydra.helper-finished' && event.data.error?.includes('helper provider failed'))
          : s.state().helper?.outcomes.some(outcome => outcome.task === task.id && outcome.summary === 'Progress checked.'),
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
      assert.ok(errors.mock.calls.some(call => call.arguments.join(' ').includes(phase === 'grant-error' ? 'grant write failed' : phase === 'grant-committed' ? 'snapshot replace failed' : 'Hydra is locked')))
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
      const faulted = new Set<string>()
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
          faulted.add(String(args[0]))
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
      await pnyx.restart()
      const s = await pnyx.scenario()
      const discovered = `discovered-${failure}`
      await s.owner({
        args: [
          'hydra',
          'create',
          discovered,
          '--helper',
          'off',
        ],
      })
      await until({
        what: 'root polling to discover and mount the new Hydra',
        check: () => fs.existsSync(join(
          process.env.PNYX_HOME!,
          'hydras',
          discovered,
          'server.json',
        )),
      })
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
      const pushed: string[] = []
      ws.on(
        'message',
        data => {
          const message = JSON.parse(String(data))

          if (message.type === 'event') {
            pushed.push(message.event.id)
          }

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
      const saved = s.events().at(-1)!
      await until({
        what: 'the saved event pushed through fallback',
        check: () => pushed.includes(saved.id),
      })
      spoolWrite({
        hydraId: s.hydraId,
        entry: {
          id: `spooled-${failure}`,
          at: new Date().toISOString(),
          key: 'spooled',
          card: { title: 'Ingested after watcher failure' },
        },
      })
      await until({
        what: 'spool polling to ingest and push an event',
        check: () => s.state().eventIds[`spooled-${failure}`] !== undefined && pushed.includes(`spooled-${failure}`),
      })
      assert.equal(
        s.task({ key: 'later' }).title,
        'After watcher failure',
      )
      const dir = join(
        process.env.PNYX_HOME!,
        'hydras',
        s.hydraId,
      )

      for (const path of [
        join(
          process.env.PNYX_HOME!,
          'hydras',
        ),
        dir,
        join(
          dir,
          'spool',
        ),
        card.agent!.transcriptPath!,
        join(
          card.agent!.transcriptPath!,
          '..',
        ),
      ]) {
        assert.ok(
          faulted.has(path),
          `EMFILE was not injected for ${path}`,
        )
      }

      assert.ok(errors.mock.calls.some(call => call.arguments.join(' ').includes('watch limit reached')))
      assert.equal(
        (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status,
        200,
      )
    },
  )
}
