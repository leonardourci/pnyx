import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { nativeProviders } from '#app/native-provider.ts'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fixtureApplication } from '#agent-host/fixtures/application-harness.ts'
import { fixtureHost, snapshot, until } from '#agent-host/fixtures/harness.ts'

const SECOND_MS = 1000

for (const provider of [
  'claude-code',
  'codex',
] as const) {
  test(
    `${provider} application attachment survives disconnect without reopening or repeating input`,
    async t => {
      const host = await fixtureHost({ t })
      const options = {
        directory: host.root,
        journal: join(
          host.root,
          'application',
        ),
        installation: 'fixture-installation',
      }
      const first = await nativeProviders(options)
      t.after(first.detach)
      const open = {
        cwd: host.root,
        env: { PNYX_ACTOR: 'opaque-role' },
        settings: {},
        signal: new AbortController().signal,
      }
      const session = await first.providers[provider].open(open)
      const events: unknown[] = []

      const consume = async () => {
        for await (const event of session.run({
          input: (async function* () {
            yield {
              id: 'message-1',
              text: 'hello',
              images: [],
            }
          })(),
          permission: async () => ({
            behavior: 'deny',
            message: 'fixture',
          }),
        })) {
          events.push(event)
        }
      }

      const reading = consume()
      await until({ check: async () => (await host.stats())[0]?.input.length === 1 })
      const bindingPath = join(
        options.journal,
        readdirSync(options.journal)[0]!,
      )
      const saved = JSON.parse(readFileSync(
        bindingPath,
        'utf8',
      ))
      assert.equal(
        'inputs' in saved,
        false,
      )
      const nativeId = session.id
      session.detach!()
      await reading
      first.detach()
      await host.control({
        kind: 'event',
        nativeId,
        event: {
          type: 'text',
          id: 'answer',
          text: 'still alive',
        },
      })
      const second = await nativeProviders(options)
      t.after(second.detach)
      const resumed = await second.providers[provider].open({
        ...open,
        agent: {
          provider,
          sessionId: nativeId,
        },
      })
      t.after(() => resumed.detach!())
      assert.equal(
        resumed.accepted?.({ id: 'message-1' }),
        true,
      )
      assert.equal(
        resumed.accepted?.({ id: 'not-yet-admitted' }),
        false,
      )
      const replay: unknown[] = []

      const observer = async () => {
        for await (const event of resumed.run({
          input: (async function* () {
            yield {
              id: 'message-1',
              text: 'regenerated context differs',
              images: [],
            }
            yield {
              id: 'not-yet-admitted',
              text: 'new logged intent',
              images: [],
            }
          })(),
          permission: async () => ({
            behavior: 'deny',
            message: 'fixture',
          }),
        })) {
          replay.push(event)
        }
      }

      const next = observer()
      await resumed.replayed!()
      await until({ check: async () => JSON.stringify(replay).includes('still alive') && (await host.stats())[0]!.input.length === 2 })
      assert.equal(
        (await host.stats()).length,
        1,
      )
      assert.equal(
        (await host.stats())[0]!.closed,
        false,
      )
      assert.deepEqual(
        (await host.stats())[0]!.input.map(input => input.id),
        [
          'message-1',
          'not-yet-admitted',
        ],
      )
      assert.equal(
        resumed.id,
        nativeId,
      )
      resumed.detach!()
      await next
    },
  )
}

for (const harness of [
  'claude',
  'codex',
] as const) {
  test(
    `${harness} Hydra and worker preserve native turns through an application SIGKILL`,
    async t => {
      const app = await fixtureApplication({ t })
      const {
        host,
        cli,
        folder,
      } = app
      const first = await app.start()
      await cli({
        args: [
          'rule',
          'set',
          'hydra',
          '--harness',
          harness,
          '--model',
          'fixture',
        ],
      })
      await cli({
        args: [
          'hydra',
          'set',
          '--helper',
          'off',
        ],
      })
      await cli({
        args: [
          'hydra',
          'send',
          '--text',
          'keep this Hydra turn running',
        ],
      })
      await cli({
        args: [
          'task',
          'create',
          '--title',
          'Survive',
          '--key',
          'survive',
          '--folder',
          folder,
          '--brief',
          'Keep running',
        ],
      })
      await cli({
        args: [
          'task',
          'start',
          'survive',
          '--via',
          'pnyx',
          '--harness',
          harness,
          '--model',
          'fixture',
          '--folder',
          folder,
        ],
      })
      await until({
        check: async () => {
          const states = await host.stats()

          return states.length === 2 && states.every(state => state.input.length === 1)
        },
      })
      const before = await host.stats()
      first.child.kill('SIGKILL')
      await first.exited

      for (const native of before) {
        await host.control({
          kind: 'event',
          nativeId: native.id,
          event: {
            type: 'text',
            id: 'held',
            text: 'during the outage',
          },
        })
      }

      await app.start()
      assert.deepEqual(
        (await host.stats()).map(state => ({
          id: state.id,
          closed: state.closed,
          inputs: state.input.length,
        })),
        before.map(state => ({
          id: state.id,
          closed: false,
          inputs: 1,
        })),
      )
      const log = readFileSync(
        join(
          app.home,
          'hydras/default/events.jsonl',
        ),
        'utf8',
      )
      assert.doesNotMatch(
        log,
        /Pnyx stopped during this turn/,
      )
    },
  )
}

test(
  'a killed host ends its recorded provider group before cold resume',
  async t => {
    const {
      mkdtempSync,
      realpathSync,
      existsSync,
      readFileSync,
      rmSync,
    } = await import('node:fs')
    const { processStart } = await import('#agent-host/discovery.ts')
    const root = realpathSync(mkdtempSync('/tmp/pnyx-tree-'))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const first = await fixtureHost({
      t,
      directory: root,
    })
    const initial = await nativeProviders({
      directory: root,
      journal: join(
        root,
        'journal',
      ),
      installation: 'fixture-installation',
    })
    t.after(initial.detach)
    const opening = initial.providers.codex.open({
      cwd: root,
      env: {},
      settings: {
        fixtureTree: '1',
        fixtureOpen: 'hold',
      },
      signal: new AbortController().signal,
    })
    const path = join(
      root,
      'owned-tree.json',
    )
    await until({ check: () => existsSync(path) })
    const owners = JSON.parse(readFileSync(
      path,
      'utf8',
    )) as Record<string, {
      pid: number
      start: string
    }>
    t.after(() => {
      for (const owner of Object.values(owners)) {
        if (processStart({ pid: owner.pid }) === owner.start) {
          process.kill(
            owner.pid,
            'SIGKILL',
          )
        }
      }
    })
    const born = Math.max(...Object.values(owners).map(owner => Date.parse(owner.start)))
    await until({ check: () => Date.now() >= born + SECOND_MS })
    await first.control({
      kind: 'release',
      nativeId: (await first.stats())[0]!.id,
    })
    const session = await opening
    session.detach!()
    first.child.kill('SIGKILL')
    await first.exited

    for (const owner of Object.values(owners)) {
      assert.equal(
        processStart({ pid: owner.pid }),
        owner.start,
      )
    }

    const replacement = await fixtureHost({
      t,
      directory: root,
    })
    const second = await nativeProviders({
      directory: root,
      journal: join(
        root,
        'journal',
      ),
      installation: 'fixture-installation',
    })
    t.after(second.detach)
    await until({
      check: () => Object.values(owners).every(owner =>
        processStart({ pid: owner.pid }) !== owner.start),
    })
    const resumed = await second.providers.codex.open({
      cwd: root,
      env: {},
      settings: {},
      agent: {
        provider: 'codex',
        sessionId: session.id,
        cwd: root,
        host: 'pnyx',
        resume: true,
      },
      signal: new AbortController().signal,
    })
    assert.equal(
      resumed.id,
      session.id,
    )
    assert.deepEqual(
      (await replacement.stats()).map(state => state.input),
      [[]],
    )
  },
)

for (const harness of [
  'claude',
  'codex',
] as const) {
  for (const result of [
    'text',
    'structured',
    'malformed',
    'late',
    'host-crash',
    'host-crash-uncertain',
  ] as const) {
    test(
      result === 'host-crash-uncertain'
        ? `${harness} helper preserves an unresolved host-crash batch and its lease`
        : `${harness} helper recovers ${result} completion and releases its outage lease`,
      async t => {
        const app = await fixtureApplication({ t })
        const {
          cli,
          folder,
        } = app
        let host = app.host
        const first = await app.start()
        await cli({
          args: [
            'task',
            'create',
            '--title',
            'Help',
            '--key',
            'help',
            '--folder',
            folder,
            '--brief',
            'Keep running',
          ],
        })
        await cli({
          args: [
            'task',
            'start',
            'help',
            '--via',
            'pnyx',
            '--harness',
            harness,
            '--model',
            'fixture',
            '--folder',
            folder,
          ],
        })
        await cli({
          args: [
            'rule',
            'set',
            'hydra',
            '--harness',
            harness,
            '--model',
            'fixture',
          ],
        })
        await cli({
          args: [
            'hydra',
            'set',
            '--helper',
            harness,
            '--helper-model',
            'fixture',
          ],
        })
        await cli({
          args: [
            'hydra',
            'send',
            '--text',
            'Hold this main turn',
          ],
        })
        await until({ check: async () => (await host.stats()).some(state => state.input.some(input => input.text.includes('Hold this main turn'))) })
        await cli({
          args: [
            'task',
            'status',
            'help',
            'blocked',
            '--note',
            'The worker needs a routine nudge',
          ],
        })
        await until({ check: async () => (await host.stats()).some(state => state.input.some(input => input.text.includes('Granted tasks:'))) })
        const helper = (await host.stats()).find(state => state.input.some(input => input.text.includes('Granted tasks:')))!
        assert.ok(helper)
        const original = new Map((await host.stats()).map(state => [
          state.id,
          state.input.map(input => input.id),
        ]))
        const batch = Object.values(app.state().helper!.runs)[0]!
        first.child.kill('SIGKILL')
        await first.exited
        await assert.rejects(
          cli({
            args: [
              'task',
              'rename',
              'help',
              '--title',
              'Competing write',
            ],
          }),
          /Command failed/,
        )
        const turn = helper.turn!
        const outcomes = {
          outcomes: [
            {
              task: batch.tasks[0],
              audience: 'routine',
              summary: 'Nudged once.',
            },
          ],
        }

        if (result === 'structured') {
          await host.control({
            kind: 'event',
            nativeId: helper.id,
            event: {
              type: 'structured',
              value: outcomes,
            },
          })
        }

        if (result === 'late') {
          await host.control({
            kind: 'event',
            nativeId: helper.id,
            event: {
              type: 'turn-ended',
              outcome: {
                turn,
                inputIds: [batch.id],
                status: 'completed',
                at: new Date(Date.parse(batch.startedAt!) + 120_001).toISOString(),
                assistant: [],
                structured: outcomes,
              },
            },
          })
        }

        if (result !== 'host-crash-uncertain') {
          await host.control({
            kind: 'event',
            nativeId: helper.id,
            event: {
              type: 'result',
              turn,
              inputIds: [batch.id],
              status: 'completed',
              final: result === 'malformed' ? '{}' : JSON.stringify(outcomes),
              queued: 0,
            },
          })
        }

        const hostLost = result === 'host-crash' || result === 'host-crash-uncertain'

        if (hostLost) {
          const observer = await host.connect()
          const summary = observer.ready.sessions.find(session => session.nativeId === helper.id)!
          const retained = await snapshot({
            client: observer,
            ref: summary.ref,
          })
          assert.equal(
            retained.pendingFacts.some(fact => fact.event.type === 'turn-ended'),
            result !== 'host-crash-uncertain',
          )
          observer.detach()
          host.child.kill('SIGKILL')
          await host.exited
          host = await fixtureHost({
            t,
            directory: app.root,
          })
        }

        const failed = result === 'malformed' || result === 'late'
        const second = await app.start()

        if (result === 'host-crash-uncertain') {
          await until({ check: () => app.errors().includes('helper retained ownership requires reconciliation') })
          assert.ok(app.state().helper!.runs[batch.id])
          assert.equal(
            app.state().helper!.runs[batch.id]!.error,
            undefined,
          )
          assert.equal(
            app.state().helper!.outcomes.length,
            0,
          )
          const resumed = await host.stats()
          assert.ok(resumed.every(state => state.id !== helper.id))

          for (const state of resumed) {
            assert.ok(state.input.every(input => !original.get(state.id)?.includes(input.id)))
          }

          await assert.rejects(
            cli({
              args: [
                'task',
                'rename',
                'help',
                '--title',
                'Must remain leased',
              ],
            }),
            /Command failed/,
          )

          return
        }

        try {
          await until({
            check: () => failed
              ? !!app.state().helper!.runs[batch.id]?.error
              : app.state().helper!.outcomes.some(outcome => outcome.summary === 'Nudged once.'),
          })

          if (result !== 'host-crash') {
            await until({
              check: async () => {
                const native = (await host.stats()).find(state => state.id === helper.id)

                return native?.closed === true
              },
            })
          }

          await until({
            check: () => !existsSync(join(
              app.home,
              'hydras/default',
              `helper-lease-${encodeURIComponent(batch.tasks[0]!)}.json`,
            )),
          })
        } catch (error) {
          t.diagnostic(JSON.stringify(app.state().helper))
          t.diagnostic(app.errors())
          t.diagnostic(JSON.stringify(await host.stats()))
          throw error
        }

        if (hostLost) {
          for (const state of await host.stats()) {
            assert.ok(state.input.every(input => !original.get(state.id)?.includes(input.id)))
          }
        } else {
          assert.equal(
            (await host.stats()).length,
            3,
          )
        }

        assert.equal(
          app.state().helper!.outcomes.filter(outcome => outcome.summary === 'Nudged once.').length,
          failed ? 0 : 1,
        )

        if (failed) {
          assert.match(
            app.state().helper!.runs[batch.id]!.error!,
            result === 'late' ? /original deadline/ : /outcome records/,
          )
        }

        await cli({
          args: [
            'task',
            'rename',
            'help',
            '--title',
            'Lease released',
          ],
        })
        second.child.kill('SIGKILL')
        await second.exited
        await app.start()
        await cli({
          args: [
            'task',
            'rename',
            'help',
            '--title',
            'Lease still released',
          ],
        })
      },
    )
  }
}

for (const harness of [
  'claude',
  'codex',
] as const) {
  for (const role of [
    'Hydra',
    'worker',
  ] as const) {
    test(
      `${harness} recovers ${role} input after its app commit but before native admission`,
      async t => {
        const app = await fixtureApplication({ t })
        const first = await app.start({ holdInputs: true })
        await app.cli({
          args: [
            'rule',
            'set',
            'hydra',
            '--harness',
            harness,
            '--model',
            'fixture',
          ],
        })
        await app.cli({
          args: [
            'hydra',
            'set',
            '--helper',
            'off',
          ],
        })
        const text = 'Keep this exact custom request through the admission gap.'

        if (role === 'Hydra') {
          await app.cli({
            args: [
              'hydra',
              'send',
              '--text',
              text,
            ],
          })
        } else {
          await app.cli({
            args: [
              'task',
              'create',
              '--title',
              'Admission',
              '--key',
              'admission',
              '--folder',
              app.folder,
            ],
          })
          await app.cli({
            args: [
              'task',
              'start',
              'admission',
              '--via',
              'pnyx',
              '--harness',
              harness,
              '--model',
              'fixture',
              '--folder',
              app.folder,
              '--prompt',
              text,
            ],
          })
        }

        const selected = () => role === 'Hydra' ? app.state().cards['$hydra'] : Object.values(app.state().cards).find(card => card.key === 'admission')
        await until({ check: () => !!selected()?.agent })
        const card = selected()!
        const nativeId = card.agent!.sessionId
        const observer = await app.host.connect()
        const summary = observer.ready.sessions.find(session => session.nativeId === nativeId)!
        const epoch = summary.ref.epoch
        await until({ check: () => first.heldInputs.some(input => input.epoch === epoch) })
        assert.equal(
          (await app.host.stats()).find(state => state.id === nativeId)!.input.length,
          0,
        )
        first.child.kill('SIGKILL')
        await first.exited
        const replacement = await app.start()
        await until({
          check: async () => {
            const state = (await app.host.stats()).find(state => state.id === nativeId)!

            return state.input.length === 1
          },
        })
        const received = (await app.host.stats()).find(state => state.id === nativeId)!.input[0]!
        assert.ok(received.text.includes(text))
        replacement.child.kill('SIGKILL')
        await replacement.exited
        await app.start()
        assert.equal(
          (await app.host.stats()).find(state => state.id === nativeId)!.input.length,
          1,
        )
      },
    )
  }
}

for (const harness of [
  'claude',
  'codex',
] as const) {
  test(
    `${harness} recovers generated wake input after its app commit but before native admission`,
    async t => {
      const app = await fixtureApplication({ t })
      const held = await app.start({ holdInputs: 'wake' })
      await app.cli({
        args: [
          'rule',
          'set',
          'hydra',
          '--harness',
          harness,
          '--model',
          'fixture',
        ],
      })
      await app.cli({
        args: [
          'hydra',
          'set',
          '--helper',
          'off',
        ],
      })
      await app.cli({
        args: [
          'hydra',
          'send',
          '--text',
          'Warm this native session.',
        ],
      })
      await until({
        check: async () => (await app.host.stats()).some(state => state.input.length === 1),
      })
      const states = await app.host.stats()
      const native = states.find(state => state.input.some(input =>
        input.text.includes('Warm this native session.')))!
      await app.host.control({
        kind: 'event',
        nativeId: native.id,
        event: {
          type: 'result',
          turn: native.turn!,
          inputIds: native.input.map(input => input.id),
          status: 'completed',
          final: 'Ready.',
          queued: 0,
        },
      })
      await until({ check: () => app.state().cards['$hydra']?.sessionActivity === 'finished' })
      await app.cli({
        args: [
          'task',
          'create',
          '--title',
          'Wake admission gap',
          '--key',
          'wake-gap',
          '--folder',
          app.folder,
        ],
      })
      await app.cli({
        args: [
          'task',
          'start',
          'wake-gap',
          '--via',
          'pnyx',
          '--harness',
          harness,
          '--model',
          'fixture',
          '--folder',
          app.folder,
        ],
      })
      await app.cli({
        args: [
          'task',
          'status',
          'wake-gap',
          'blocked',
          '--note',
          'Needs a new main turn.',
        ],
      })
      const pendingWake = () => readFileSync(
        join(
          app.home,
          'hydras/default/events.jsonl',
        ),
        'utf8',
      )
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { nativeInput?: { id: string } })
        .find(event => event.nativeInput?.id.startsWith('wake:'))?.nativeInput

      await until({ check: () => !!pendingWake() })

      const id = pendingWake()!.id
      await until({ check: () => held.heldInputs.some(input => input.id === id) })
      assert.equal(
        (await app.host.stats()).find(state => state.id === native.id)!.input.length,
        1,
      )
      held.child.kill('SIGKILL')
      await held.exited
      const resumed = await app.start()
      await until({
        check: async () => {
          const current = (await app.host.stats()).find(state => state.id === native.id)!

          return current.input.some(input => input.id === id)
        },
      })
      resumed.child.kill('SIGKILL')
      await resumed.exited
      await app.start()
      const current = (await app.host.stats()).find(state => state.id === native.id)!
      assert.equal(
        current.input.filter(input => input.id === id).length,
        1,
      )
    },
  )
}

for (const provider of [
  'claude-code',
  'codex',
] as const) {
  test(
    `${provider} refreshes surviving context on input, compaction and reattachment`,
    async t => {
      const host = await fixtureHost({ t })
      const options = {
        directory: host.root,
        journal: join(
          host.root,
          'journal',
        ),
        installation: 'fixture-installation',
      }
      let digest = 'memory-v1'
      const initial = await nativeProviders(options)
      t.after(initial.detach)
      const open = {
        cwd: host.root,
        env: {},
        settings: {},
        signal: new AbortController().signal,
        context: () => digest,
      }
      const session = await initial.providers[provider].open(open)
      assert.equal(
        (await host.stats())[0]!.context,
        'memory-v1',
      )
      digest = 'memory-v2'
      const events: unknown[] = []

      const run = async () => {
        for await (const event of session.run({
          input: (async function* () {
            yield {
              id: 'first',
              text: 'First',
              images: [],
            }
          })(),
          permission: async () => ({ behavior: 'allow' }),
        })) {
          events.push(event)
        }
      }

      const running = run()
      await until({ check: async () => (await host.stats())[0]!.input.length === 1 })
      assert.equal(
        (await host.stats())[0]!.context,
        'memory-v2',
      )
      digest = 'memory-v3'
      await host.control({
        kind: 'event',
        nativeId: session.id,
        event: {
          type: 'compaction',
          id: 'compact',
          state: 'done',
          trigger: 'auto',
        },
      })
      await until({ check: () => events.some(event => typeof event === 'object' && (event as { type: string }).type === 'compaction') })
      assert.equal(
        (await host.stats())[0]!.context,
        'memory-v3',
      )
      session.detach!()
      await running
      initial.detach()
      digest = 'memory-v4'
      const replacement = await nativeProviders(options)
      t.after(replacement.detach)
      const resumed = await replacement.providers[provider].open({
        ...open,
        agent: {
          provider,
          sessionId: session.id,
        },
      })
      t.after(() => resumed.detach!())
      assert.equal(
        (await host.stats())[0]!.context,
        'memory-v4',
      )
      assert.equal(
        (await host.stats())[0]!.input.length,
        1,
      )
    },
  )
}

test(
  'completion replay keeps one tagged task note after an application SIGKILL before acknowledgement',
  async t => {
    const { taskMention } = await import('#hydra/mentions.ts')
    const app = await fixtureApplication({ t })
    const first = await app.start({ holdCompletionAcks: true })
    await app.cli({
      args: [
        'rule',
        'set',
        'hydra',
        '--harness',
        'codex',
        '--model',
        'fixture',
      ],
    })
    await app.cli({
      args: [
        'hydra',
        'set',
        '--helper',
        'off',
      ],
    })
    await app.cli({
      args: [
        'task',
        'create',
        '--title',
        'Note target',
        '--key',
        'note-target',
        '--folder',
        app.folder,
      ],
    })
    const task = app.state().keys['note-target']!
    const notes = () => readFileSync(
      join(
        app.home,
        'hydras/default/events.jsonl',
      ),
      'utf8',
    ).trim()
      .split('\n')
      .map(line => JSON.parse(line) as {
        type: string
        cardId: string
        data: { text: string }
      })
      .filter(event => event.type === 'card.noted' && event.cardId === task && event.data.text === 'Recorded once.')
    await app.cli({
      args: [
        'hydra',
        'send',
        '--text',
        'Please report on the target',
      ],
    })
    await until({ check: async () => (await app.host.stats())[0]?.input.length === 1 })
    const native = (await app.host.stats())[0]!
    await app.host.control({
      kind: 'event',
      nativeId: native.id,
      event: {
        type: 'text',
        id: 'reply',
        text: `${taskMention({
          id: task,
          title: 'Note target',
        })} Recorded once.`,
      },
    })
    await app.host.control({
      kind: 'event',
      nativeId: native.id,
      event: {
        type: 'result',
        turn: native.turn!,
        inputIds: native.input.map(input => input.id),
        status: 'completed',
        queued: 0,
      },
    })
    await until({ check: () => notes().length === 1 })
    first.child.kill('SIGKILL')
    await first.exited
    await app.start()
    assert.equal(
      notes().length,
      1,
    )
    assert.equal(
      (await app.host.stats())[0]!.input.length,
      1,
    )
  },
)

test(
  'an idle native host restart reconnects the same running application before opening new work',
  async t => {
    const app = await fixtureApplication({ t })
    const application = await app.start()
    assert.equal(
      (await app.host.stats()).length,
      0,
    )
    app.host.child.kill('SIGKILL')
    await app.host.exited
    const replacement = await fixtureHost({
      t,
      directory: app.root,
    })
    const observer = await replacement.connect()
    const expected = observer.ready.instance
    observer.detach()
    await until({
      check: async () => {
        const status = await application.control({ kind: 'connection' }) as {
          available: boolean
          instance: string
        }

        return status.available && status.instance === expected
      },
    })
    await app.cli({
      args: [
        'rule',
        'set',
        'hydra',
        '--harness',
        'codex',
        '--model',
        'fixture',
      ],
    })
    await app.cli({
      args: [
        'hydra',
        'set',
        '--helper',
        'off',
      ],
    })
    await app.cli({
      args: [
        'hydra',
        'send',
        '--text',
        'Use the reconnected native owner.',
      ],
    })
    await until({ check: async () => (await replacement.stats()).some(state => state.input.some(input => input.text.includes('Use the reconnected native owner.'))) })
    assert.equal(
      application.child.exitCode,
      null,
    )
    assert.equal(
      application.child.signalCode,
      null,
    )
    assert.equal(
      (await replacement.stats()).length,
      1,
    )
  },
)

test(
  'a lost native input reply reconnects the running application without repeating the admitted input',
  async t => {
    const { loseInputReply } = await import('#agent-host/fixtures/socket-proxy.ts')
    const app = await fixtureApplication({ t })
    const proxy = await loseInputReply({
      directory: app.root,
      text: 'Lose this input receipt.',
      holdAttach: true,
    })
    t.after(proxy.close)
    const application = await app.start({ traceOpens: true })
    await app.cli({
      args: [
        'rule',
        'set',
        'hydra',
        '--harness',
        'codex',
        '--model',
        'fixture',
      ],
    })
    await app.cli({
      args: [
        'hydra',
        'set',
        '--helper',
        'off',
      ],
    })
    await app.cli({
      args: [
        'task',
        'create',
        '--title',
        'Wake peer',
        '--key',
        'wake-peer',
        '--folder',
        app.folder,
      ],
    })
    await app.cli({
      args: [
        'task',
        'start',
        'wake-peer',
        '--via',
        'pnyx',
        '--harness',
        'codex',
        '--model',
        'fixture',
        '--folder',
        app.folder,
      ],
    })
    await app.cli({
      args: [
        'hydra',
        'send',
        '--text',
        'Lose this input receipt.',
      ],
    })
    await until({ check: proxy.dropped })
    await until({ check: proxy.attached })
    await app.cli({
      args: [
        'task',
        'status',
        'wake-peer',
        'blocked',
        '--note',
        'Needs main while it reconnects.',
      ],
    })
    await until({
      check: async () => {
        const result = await application.control({ kind: 'trace' }) as {
          traces: {
            kind: string
            details: { actor?: string }
          }[]
        }

        return result.traces.filter(event => event.kind === 'open-start' && event.details.actor === 'hydra').length >= 3
      },
    })
    proxy.release()
    type Trace = {
      kind: string
      details: {
        attempt?: number
        actor?: string
        nativeId?: string
        error?: string
      }
    }

    const readTrace = async () => {
      const result = await application.control({ kind: 'trace' }) as { traces: Trace[] }

      return result.traces
    }

    await until({
      check: async () => {
        const events = await readTrace()
        const reopening = events.filter(event => event.kind === 'open-start'
          && event.details.actor === 'hydra' && event.details.nativeId)

        const ended = new Set(events.filter(event => event.kind === 'open-end'
          || event.kind === 'open-failed').map(event => event.details.attempt))

        return reopening.every(open => ended.has(open.details.attempt))
      },
    })
    const completedOpens = await readTrace()
    assert.deepEqual(
      completedOpens.filter(event => event.kind === 'open-failed'),
      [],
    )
    await app.cli({
      args: [
        'hydra',
        'send',
        '--text',
        'A second input after reconciliation.',
      ],
    })

    try {
      await until({ check: async () => (await app.host.stats()).some(state => state.input.some(input => input.text.includes('A second input after reconciliation.'))) })
    } catch (error) {
      t.diagnostic(JSON.stringify(await application.control({ kind: 'trace' })))
      t.diagnostic(app.errors())
      throw error
    }

    const states = await app.host.stats()
    const hydra = states.find(state => state.input.some(input => input.text.includes('Lose this input receipt.')))!
    assert.equal(
      states.length,
      2,
    )
    assert.equal(
      hydra.input.filter(input => input.text.includes('Lose this input receipt.')).length,
      1,
    )
    assert.equal(
      hydra.input.filter(input => input.text.includes('A second input after reconciliation.')).length,
      1,
    )
    assert.equal(
      application.child.exitCode,
      null,
    )
    assert.equal(
      application.child.signalCode,
      null,
    )
  },
)
