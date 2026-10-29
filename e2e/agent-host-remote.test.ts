import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { nativeProviders } from '#app/native-provider.ts'
import { readFileSync } from 'node:fs'
import { fixtureApplication } from '#agent-host/fixtures/application-harness.ts'
import { fixtureHost, until } from '#agent-host/fixtures/harness.ts'

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
      const replay: unknown[] = []

      const observer = async () => {
        for await (const event of resumed.run({
          input: (async function* () {})(),
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
      await until({ check: () => JSON.stringify(replay).includes('still alive') })
      assert.equal(
        (await host.stats()).length,
        1,
      )
      assert.equal(
        (await host.stats())[0]!.closed,
        false,
      )
      assert.equal(
        (await host.stats())[0]!.input.length,
        1,
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
  'a killed host refuses cold reopen while its real provider and tool descendants survive',
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
    const session = await initial.providers.codex.open({
      cwd: root,
      env: {},
      settings: { fixtureTree: '1' },
      signal: new AbortController().signal,
    })
    session.detach!()
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
    first.child.kill('SIGKILL')
    await first.exited

    for (const owner of Object.values(owners)) {
      assert.equal(
        processStart({ pid: owner.pid }),
        owner.start,
      )
    }

    await fixtureHost({
      t,
      directory: root,
    })
    const second = await nativeProviders({
      directory: root,
      journal: join(
        root,
        'other-journal',
      ),
      installation: 'fixture-installation',
    })
    t.after(second.detach)
    await assert.rejects(
      second.providers.codex.open({
        cwd: root,
        env: {},
        settings: {},
        signal: new AbortController().signal,
      }),
      /ownership|reconcil/i,
    )
  },
)

for (const harness of [
  'claude',
  'codex',
] as const) {
  test(
    `${harness} helper keeps its lease during an outage and replays its original completion once`,
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
      await host.control({
        kind: 'event',
        nativeId: helper.id,
        event: {
          type: 'result',
          turn,
          inputIds: [batch.id],
          status: 'completed',
          final: JSON.stringify({
            outcomes: [
              {
                task: batch.tasks[0],
                audience: 'routine',
                summary: 'Nudged once.',
              },
            ],
          }),
          queued: 0,
        },
      })
      await app.start()

      try {
        await until({ check: () => app.state().helper!.outcomes.some(outcome => outcome.summary === 'Nudged once.') })
      } catch (error) {
        t.diagnostic(JSON.stringify(app.state().helper))
        t.diagnostic(app.errors())
        t.diagnostic(JSON.stringify(await host.stats()))
        throw error
      }

      assert.equal(
        (await host.stats()).length,
        3,
      )
      assert.equal(
        app.state().helper!.outcomes.filter(outcome => outcome.summary === 'Nudged once.').length,
        1,
      )
      await cli({
        args: [
          'task',
          'rename',
          'help',
          '--title',
          'Lease released',
        ],
      })
    },
  )
}
