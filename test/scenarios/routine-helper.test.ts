import { until } from '../../src/test-harness/harness.ts'
import { decidePush } from '../../src/core/decide.ts'
import { REVIEW_MS } from '../../src/review/timer.ts'
import { createHost } from '../../src/server/host.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { commands } from '../../src/cli/commands.ts'
import { hydraConfig, hydraEvent, HYDRA_CARD } from '../../src/core/hydra.ts'
import type { HydraEvent } from '../../src/app/model.ts'
import type { QueryFn } from '../../src/server/claude.ts'
import { startServer } from '../../src/app/server-daemon.ts'
import { localToken } from '../../src/server/state.ts'
import { taskLease } from '../../src/helper/leases.ts'
import { withWriter } from '../../src/app/writer.ts'
import { loadHydra } from '../../src/app/store.ts'
import { readEvents } from '../../src/app/event-log.ts'
import { fakeDispatch } from '../../src/test-harness/dispatch-fixture.ts'
import { hydraSdk } from '../../src/test-harness/hydra-host-fixture.ts'

test(
  'the helper command example resumes an interrupted hosted worker with its supplied actor',
  { timeout: 30_000 },
  async () => {
    const restore = { ...process.env }
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-helper-actor-',
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
    commands.hydra([
      'set',
      '--helper',
      'off',
      '--hydra',
      'lab',
    ])
    commands.task([
      'create',
      '--key',
      'work',
      '--title',
      'Resume work',
      '--hydra',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const task = state().keys.work!
    const sdk = hydraSdk()
    sdk.control.reply = 'NO_REPLY'
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      homes: [],
    })
    const run = promisify(execFile)
    const cli = async ({
      args,
      env = process.env,
    }: {
      args: string[]
      env?: NodeJS.ProcessEnv
    }) =>
      run(
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
    let release = () => {}

    try {
      await cli({
        args: [
          'task',
          'start',
          task,
          '--folder',
          root,
          '--harness',
          'claude',
        ],
      })
      await until({
        what: 'the worker to finish its opening turn',
        check: () => state().cards[task]?.sessionActivity === 'finished',
      })
      withWriter({
        hydraId: 'lab',
        fn: ({ writer }) => {
          const card = writer.state.cards[task]!
          const interrupted = decidePush({
            state: writer.state,
            key: card.key,
            input: {
              activity: 'interrupted',
              agent: card.agent,
            },
            meta: {
              at: new Date().toISOString(),
              actor: 'pnyx',
            },
          })
          assert.ok('event' in interrupted)
          writer.append({ event: interrupted.event })
          const grant = hydraEvent({
            state: writer.state,
            cardId: HYDRA_CARD,
            meta: {
              at: new Date().toISOString(),
              actor: 'pnyx',
            },
            change: {
              type: 'hydra.helper-started',
              data: {
                id: 'resume',
                tasks: [task],
                prompt: 'Resume the interrupted worker',
                seqs: [],
              },
            },
          })
          assert.ok('event' in grant)
          writer.append({ event: grant.event })
        },
      })
      release = taskLease({
        hydraId: 'lab',
        task,
        actor: 'helper:resume',
      })
      const env = {
        ...process.env,
        PNYX_ACTOR: 'helper:resume',
        PNYX_HYDRA: 'lab',
      }
      await assert.rejects(
        cli({
          args: [
            'reply',
            task,
            '--text',
            'Resume',
            '--actor',
            'hydra',
          ],
          env,
        }),
        (error: unknown) => {
          assert.ok(error && typeof error === 'object' && 'stdout' in error)
          assert.match(
            String(error.stdout),
            /MAIN_ONLY/,
          )

          return true
        },
      )
      await cli({
        args: [
          'reply',
          task,
          '--text',
          'Continue within the accepted scope.',
        ],
        env,
      })
      const steering = state().cards[task]!.steering!.at(-1)!
      assert.equal(
        steering.text,
        'Continue within the accepted scope.',
      )
      assert.equal(
        steering.actor,
        'helper:resume',
      )
    } finally {
      release()
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
    commands.task([
      'create',
      '--key',
      'other',
      '--title',
      'Other',
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
    const other = state().keys.other!
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
        {
          task: other,
          audience: 'routine',
          summary: 'Other worker is progressing.',
        },
      ],
    })
    helper.control.structured = JSON.parse(helper.control.reply)
    helper.control.reply = 'Neither restart nor nudge is open to me.\n```json\n{}\n```'
    helper.control.usage = {
      context: 2400,
      window: 200_000,
      cost: 0.12,
    }
    main.control.usage = {
      context: 4800,
      window: 200_000,
      cost: 0.30,
    }
    // eslint-disable-next-line pnyx/object-params -- The SDK owns this callback signature.
    const query: QueryFn = args => args.options?.env?.PNYX_ACTOR?.startsWith('helper:')
      ? helper.query(args) : main.query(args)
    let reviewNow = Date.now()
    const reviewTicks: (() => void)[] = []
    const server = await startServer({
      hydraId: 'lab',
      query,
      homes: [],
      wakeDelay: 0,
      reviewClock: {
        now: () => reviewNow,
        interval: ({ run }) => {
          reviewTicks.push(run)

          return () => {}
        },
      },
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
      const seqs: number[] = []
      withWriter({
        hydraId: 'lab',
        fn: ({ writer }) => {
          for (const id of [
            task,
            other,
          ]) {
            const decision = hydraEvent({
              state: writer.state,
              cardId: id,
              meta: {
                at: new Date().toISOString(),
                actor: `worker:${id}`,
              },
              change: {
                type: 'hydra.message',
                data: {
                  action: 'send',
                  hydra: 'hydra',
                  task: id,
                  kind: 'progress',
                  text: 'Worker made progress',
                },
              },
            })
            assert.ok('event' in decision)
            seqs.push(decision.event.seq)
            writer.append({ event: decision.event })
          }
        },
      })
      const grant = await event({ matches: ({ event: e }) => e.seq > progress && e.type === 'hydra.helper-started' })
      assert.ok(grant.type === 'hydra.helper-started')
      assert.deepEqual(
        grant.data.tasks,
        [
          task,
          other,
        ],
      )
      assert.deepEqual(
        grant.data.seqs,
        seqs,
      )

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
      const beforeReview = state().seq
      reviewNow += REVIEW_MS

      for (const tick of reviewTicks) {
        tick()
      }

      await finishAfter({ after: beforeReview })
      const reviewInput = main.calls.flatMap(call => call.raw).find(text => text.includes('- timed review'))!
      assert.ok(reviewInput)
      assert.ok(
        !reviewInput.includes('Worker made progress'),
        'main must not read the reports held by the helper',
      )
      assert.ok(
        !reviewInput.includes('<pnyx-report'),
        'no held report envelope is attached to the timed review',
      )
      assert.ok(reviewInput.includes(`held by helper:${grant.data.id}, started ${grant.at}`))
      assert.ok(reviewInput.includes('do not retry a leased action'))
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
      const contract = readFileSync(
        join(
          helper.calls[0]!.options.cwd!,
          'AGENTS.md',
        ),
        'utf8',
      )
      assert.ok(contract.startsWith("You are Hydra's routine helper, not the main Hydra."))
      assert.ok(contract.indexOf('never pass --actor') < contract.indexOf('# Hydra'))
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
        3,
      )
      helper.control.hold = true
      helper.control.structured = undefined
      helper.control.usage!.cost = 0.24
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
      await event({ matches: ({ event: e }) => e.type === 'hydra.helper-started' && e.seq > quiet.seq })
      main.control.hold = true
      let firstReceived = () => {}
      const firstInput = new Promise<void>(resolve => {
        firstReceived = resolve
      })

      main.control.onInput = ({ text }) => {
        if (text.includes('Hold the main turn')) {
          firstReceived()
        }
      }

      assert.equal(
        (await cli({
          args: [
            'hydra',
            'send',
            '--text',
            'Hold the main turn while I add context.',
          ],
        })).code,
        0,
      )
      await firstInput
      helper.release()
      await event({ matches: ({ event: e }) => e.type === 'hydra.helper-finished' && e.seq > quiet.seq })
      assert.equal(
        (await cli({
          args: [
            'hydra',
            'send',
            '--text',
            'Owner arrives after helper finishes.',
          ],
        })).code,
        0,
      )
      const later = state().hydraMessages!.findLast(message => message.text === 'Owner arrives after helper finishes.')!
      await event({ matches: ({ event: e }) => e.id === `${later.id}:hosted` })
      assert.equal(
        main.control.hold,
        true,
      )
      main.release()
      await event({ matches: ({ event: e }) => e.type === 'hydra.helper-acknowledged' && e.data.through > quiet.seq })
      assert.ok(main.calls[0]!.messages.some(text => text.includes(`- [@Work](pnyx-task:${task}): Findings ready: https://example.test/findings`)))
      assert.equal(
        helper.calls[1]!.options.resume,
        helper.calls[0]!.options.sessionId,
      )
      assert.equal(
        state().helper!.outcomes.length,
        3,
      )
      const measured = await commands.hydra([
        'usage',
        '--hydra',
        'lab',
      ])
      assert.ok(typeof measured.helper === 'object' && measured.helper !== null)
      const helperUsage = measured.helper as {
        batches: number
        cost: number
      }
      assert.equal(
        helperUsage.batches,
        2,
      )
      assert.equal(
        helperUsage.cost,
        0.24,
      )
      assert.equal(
        measured.combinedCost,
        0.54,
      )
      const beforeFailure = state().seq
      helper.control.usage!.cost = 0.36
      helper.control.reply = 'NO_REPLY'
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
            'Failed helper progress',
            '--actor',
            `worker:${task}`,
          ],
        })).code,
        0,
      )
      const failure = await event({ matches: ({ event: e }) => e.seq > beforeFailure && e.type === 'hydra.helper-finished' && !!e.data.error })
      await event({ matches: ({ event: e }) => e.seq > failure.seq && e.type === 'hydra.helper-acknowledged' && e.data.batches.length > 0 })
      assert.ok(main.calls[0]!.messages.some(text => text.includes('Helper hand-back:') && text.includes('Failed helper progress')))
      assert.equal(
        state().helper!.usage?.cost,
        0.36,
      )
      assert.equal(
        state().helper!.usage?.batches,
        3,
      )
      assert.deepEqual(
        state().helper!.runs,
        {},
      )
      const finishedBatches = readEvents({ hydraId: 'lab' }).filter(e => e.type === 'hydra.helper-started').length
      await server.close()
      const resumed = createHost({
        hydraId: 'lab',
        query,
        changed: () => {},
      })
      await resumed.recover()
      const restoredUsage = await resumed.usage()
      assert.ok('helper' in restoredUsage)
      assert.equal(
        restoredUsage.helper?.cost,
        0.36,
      )
      assert.deepEqual(
        resumed.queue().waiting,
        [],
      )
      assert.equal(
        readEvents({ hydraId: 'lab' }).filter(e => e.type === 'hydra.helper-started').length,
        finishedBatches,
      )
      resumed.close()
    } finally {
      main.release()
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
