import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { commands } from '../../src/cli/commands.ts'
import { hydraConfig, hydraEvent, HYDRA_CARD } from '../../src/core/hydra.ts'
import type { HydraEvent } from '../../src/core/model.ts'
import type { QueryFn } from '../../src/server/claude.ts'
import { startServer } from '../../src/server/server.ts'
import { localToken } from '../../src/server/state.ts'
import { loadHydra, readEvents, withWriter } from '../../src/store/hydra-store.ts'
import { fakeDispatch } from '../dispatch-fixture.ts'
import { hydraSdk } from '../hydra-host-fixture.ts'

test(
  'isolated real CLI routes routine work to a separate helper while owner messages reach main, then relays owner outcomes',
  { timeout: 30_000 },
  async t => {
    const restore = { ...process.env }
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-helper-scenario-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    process.env.CLAUDE_CONFIG_DIR = join(
      root,
      'claude',
    )
    process.env.CODEX_HOME = join(
      root,
      'codex',
    )
    process.env.PNYX_SEMANTIC = 'off'
    process.env.PNYX_GH_AXI = 'false'
    fakeDispatch({ root })
    commands.hydra([
      'create',
      'lab',
    ])
    commands.task([
      'create',
      '--key',
      'work',
      '--title',
      'Work',
      '--hydra',
      'lab',
    ])
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const config = hydraConfig({ state: writer.state })
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
              ...config,
              hydra: {
                ...config.hydra,
                agent: {
                  harness: 'claude',
                  model: 'opus',
                },
              },
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const task = state().keys.work!
    const main = hydraSdk()
    const helper = hydraSdk()
    helper.control.hold = true
    helper.control.stream = true
    helper.control.reply = JSON.stringify({
      outcomes: [
        {
          task,
          audience: 'routine',
          summary: 'Worker is progressing within scope.',
        },
      ],
    })
    // eslint-disable-next-line pnyx/object-params -- The SDK owns this callback signature.
    const query: QueryFn = args => args.options?.env?.PNYX_ACTOR?.startsWith('helper:')
      ? helper.query(args) : main.query(args)
    const server = await startServer({
      hydraId: 'lab',
      query,
      homes: [],
      wakeDelay: 0,
    })
    t.after(async () => {
      await server.close()
    })
    const url = new URL(server.url)
    const ws = new WebSocket(`ws://127.0.0.1:${url.port}/hydra/lab/ws?token=${localToken()}`)
    await once(
      ws,
      'open',
    )

    function event({ matches }: {
      matches({ event }: { event: HydraEvent }): boolean
    }): Promise<HydraEvent> {
      return new Promise((
        resolve,
        reject,
      ) => {
        t.signal.addEventListener(
          'abort',
          () => reject(new Error('Scenario stopped')),
          { once: true },
        )

        const check = () => {
          const found = readEvents({ hydraId: 'lab' }).find(event => matches({ event }))

          if (found) {
            ws.off(
              'message',
              check,
            )
            resolve(found)
          }
        }

        ws.on(
          'message',
          check,
        )
        check()
      })
    }

    async function cli({
      args,
      env = process.env,
    }: {
      args: string[]
      env?: NodeJS.ProcessEnv
    }) {
      const child = spawn(
        process.execPath,
        [
          join(
            import.meta.dirname,
            '../../dist/cli/pnyx-axi.js',
          ),
          ...args,
          '--hydra',
          'lab',
        ],
        { env },
      )
      let output = ''
      child.stdout.on(
        'data',
        chunk => {
          output += String(chunk)
        },
      )
      child.stderr.on(
        'data',
        chunk => {
          output += String(chunk)
        },
      )
      const [code] = await once(
        child,
        'close',
      )

      return {
        code,
        output,
      }
    }

    const finishAfter = ({ after }: { after: number }) => event({ matches: ({ event: e }) => e.seq > after && e.type === 'card.pushed' && e.data.agent?.sessionId === state().cards[HYDRA_CARD]?.agent?.sessionId && e.data.activity === 'finished' })

    try {
      const hello = state().seq
      assert.equal(
        (await cli({
          args: [
            'hydra',
            'send',
            '--text',
            'Keep work within the accepted scope.',
          ],
        })).code,
        0,
      )
      await finishAfter({ after: hello })
      const progress = state().seq
      assert.equal(
        (await cli({
          args: [
            'hydra',
            'send',
            '--task',
            task,
            '--kind',
            'progress',
            '--text',
            'Worker made progress',
            '--actor',
            `worker:${task}`,
          ],
        })).code,
        0,
      )
      await event({ matches: ({ event: e }) => e.seq > progress && e.type === 'hydra.helper-started' })

      assert.equal(
        (await cli({
          args: [
            'task',
            'status',
            task,
            'working',
            '--actor',
            'hydra',
          ],
        })).code,
        1,
      )
      const owner = state().seq
      assert.equal(
        (await cli({
          args: [
            'hydra',
            'send',
            '--text',
            'Tell me where things stand now.',
          ],
        })).code,
        0,
      )
      await finishAfter({ after: owner })
      assert.equal(
        helper.control.hold,
        true,
      )
      assert.equal(
        main.calls.length,
        1,
      )
      assert.ok(main.calls[0]!.messages.some(text => text.includes('Tell me where things stand now.')))
      assert.equal(
        helper.calls[0]!.options.model,
        'sonnet',
      )
      assert.equal(
        main.calls[0]!.options.model,
        'opus',
      )
      assert.ok(helper.calls[0]!.raw[0]!.includes('Keep work within the accepted scope.'))
      const helperEnv = helper.calls[0]!.options.env!
      const reserved = await cli({
        args: [
          'task',
          'merge',
          task,
        ],
        env: helperEnv,
      })
      assert.equal(
        reserved.code,
        1,
      )
      assert.match(
        reserved.output,
        /main Hydra/,
      )

      helper.release()
      const quiet = await event({ matches: ({ event: e }) => e.type === 'hydra.helper-finished' && !e.data.error })
      assert.equal(
        main.calls[0]!.messages.length,
        2,
      )
      helper.control.reply = JSON.stringify({
        outcomes: [
          {
            task,
            audience: 'owner',
            summary: 'Findings ready: https://example.test/findings',
          },
        ],
      })
      assert.equal(
        (await cli({
          args: [
            'hydra',
            'send',
            '--task',
            task,
            '--kind',
            'progress',
            '--text',
            'Findings available',
            '--actor',
            `worker:${task}`,
          ],
        })).code,
        0,
      )
      await event({ matches: ({ event: e }) => e.type === 'hydra.helper-acknowledged' && e.data.through > quiet.seq })
      assert.ok(main.calls[0]!.messages.some(text => text.includes(`- ${task}: Findings ready: https://example.test/findings`)))
      assert.equal(
        helper.calls[1]!.options.resume,
        helper.calls[0]!.options.sessionId,
      )
      assert.equal(
        state().helper!.outcomes.length,
        2,
      )
    } finally {
      helper.release()
      ws.close()
      await server.close()
      process.env = restore
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
