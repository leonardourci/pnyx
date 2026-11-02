import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { acquireLock } from '#store/storage.ts'
import { fixtureApplication } from '#agent-host/fixtures/application-harness.ts'
import { nativeProviders } from '#app/native-provider.ts'
import { taskMention } from '#hydra/mentions.ts'
import { fixtureHost, snapshot, until } from '#agent-host/fixtures/harness.ts'

for (const provider of [
  'claude-code',
  'codex',
] as const) {
  const loginChange = provider === 'codex' ? ' and login changes' : ''
  test(
    `${provider} reapplies a retained completion after an attachment fails${loginChange}`,
    async t => {
      const host = await fixtureHost({ t })
      const native = await nativeProviders({
        directory: host.root,
        journal: join(
          host.root,
          'bindings',
        ),
        installation: 'fixture-installation',
      })
      t.after(native.detach)
      const options = {
        cwd: host.root,
        env: provider === 'codex' ? {
          CODEX_HOME: join(
            host.root,
            'old-login',
          ),
        } : {},
        settings: {},
        signal: new AbortController().signal,
      }
      const session = await native.providers[provider].open(options)
      t.after(() => session.detach!())
      const reading = (async () => {
        for await (const event of session.run({
          input: (async function* () {
            yield {
              id: 'original',
              text: 'Finish this once',
              images: [],
            }
          })(),
          permission: async () => ({
            behavior: 'deny',
            message: 'fixture',
          }),
        })) {
          if (event === 'working') {
            break
          }
        }
      })()
      await until({ check: async () => (await host.stats())[0]?.input.length === 1 })
      session.detach!()
      await reading
      const state = (await host.stats())[0]!
      await host.control({
        kind: 'event',
        nativeId: session.id,
        event: {
          type: 'result',
          turn: state.turn!,
          inputIds: ['original'],
          status: 'completed',
          queued: 0,
        },
      })
      const agent = {
        provider,
        sessionId: session.id,
      }
      await assert.rejects(
        native.providers[provider].open({
          ...options,
          agent,
          context: () => {
            throw new Error('Application writer is busy')
          },
        }),
        /Application writer is busy/,
      )
      const resumed = await native.providers[provider].open({
        ...options,
        env: provider === 'codex' ? {
          CODEX_HOME: join(
            host.root,
            'new-login',
          ),
        } : options.env,
        agent,
      })
      t.after(() => resumed.detach!())
      const outcomes: string[] = []
      const replay = (async () => {
        for await (const event of resumed.attach!()) {
          if (typeof event === 'object' && event.type === 'turn-ended') {
            outcomes.push(event.outcome.status)
          }

          if (typeof event === 'object' && event.type === 'input' && event.receipt.phase === 'settled') {
            await resumed.applied!()
            break
          }
        }
      })()
      await replay
      assert.deepEqual(
        outcomes,
        ['completed'],
      )
      const observer = await host.connect()
      const retained = await snapshot({
        client: observer,
        ref: observer.ready.sessions[0]!.ref,
      })
      assert.deepEqual(
        retained.pendingFacts,
        [],
      )
      observer.detach()
      resumed.detach!()
      const again = await native.providers[provider].open({
        ...options,
        agent,
      })
      t.after(() => again.detach!())
      let reportedWorking = false, sawMarker = false
      const readingAgain = (async () => {
        for await (const event of again.attach!()) {
          if (event === 'working') {
            reportedWorking = true
          }

          if (typeof event === 'object' && event.type === 'text' && event.id === 'marker') {
            sawMarker = true
            break
          }
        }
      })()
      await host.control({
        kind: 'event',
        nativeId: session.id,
        event: {
          type: 'text',
          id: 'marker',
          text: 'read after replay',
        },
      })
      await until({ check: () => sawMarker })
      await readingAgain
      assert.equal(
        reportedWorking,
        false,
      )
      assert.equal(
        (await host.stats())[0]!.input.length,
        1,
      )
    },
  )
}

test(
  'the application retries finished turns after writer contention without a new message',
  async t => {
    const app = await fixtureApplication({
      t,
      built: false,
    })
    await app.start()
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
        'Finish through contention',
      ],
    })
    await app.cli({
      args: [
        'task',
        'create',
        '--title',
        'Worker',
        '--key',
        'worker',
        '--folder',
        app.folder,
        '--brief',
        'Finish',
      ],
    })
    await app.cli({
      args: [
        'task',
        'start',
        'worker',
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
    await until({
      check: async () => {
        const states = await app.host.stats()

        return states.length === 2 && states.every(state => state.input.length === 1)
      },
    })
    const states = await app.host.stats()
    const release = acquireLock({
      dir: join(
        app.home,
        'hydras/default',
      ),
    })

    try {
      for (const state of states) {
        await app.host.control({
          kind: 'event',
          nativeId: state.id,
          event: {
            type: 'result',
            turn: state.turn!,
            inputIds: state.input.map(input => input.id),
            status: 'completed',
            queued: 0,
          },
        })
      }

      await until({
        timeout: 15000,
        check: () => app.errors().includes('native attachment: Hydra is locked'),
      }).catch(error => {
        t.diagnostic(app.errors()); throw error
      })
    } finally {
      release()
    }

    const hydraId = app.state().cards.$hydra?.agent?.sessionId
    assert.ok(hydraId)
    await until({
      check: () => readFileSync(
        join(
          app.home,
          'hydras/default/events.jsonl',
        ),
        'utf8',
      ).split('\n')
        .slice(
          0,
          -1,
        )
        .map(line => JSON.parse(line))
        .some(event => event.type === 'card.pushed'
          && event.data.agent?.sessionId === hydraId && event.data.activity === 'finished')
        && Object.values(app.state().cards).find(card => card.key === 'worker')?.sessionActivity === 'finished',
    }).catch(async error => {
      const cards = Object.values(app.state().cards).map(card => ({
        key: card.key,
        activity: card.sessionActivity,
      }))
      const observer = await app.host.connect()
      const retained = await Promise.all(observer.ready.sessions.map(async session => ({
        id: session.nativeId,
        facts: (await snapshot({
          client: observer,
          ref: session.ref,
        })).pendingFacts.map(fact => fact.event.type),
      })))
      observer.detach()
      const events = readFileSync(
        join(
          app.home,
          'hydras/default/events.jsonl',
        ),
        'utf8',
      ).split('\n')
        .slice(
          0,
          -1,
        )
        .map(line => JSON.parse(line))
        .filter(event => event.type === 'card.pushed')
        .map(event => ({
          id: event.id,
          key: event.data.key,
          activity: event.data.activity,
        }))
      t.diagnostic(JSON.stringify({
        cards,
        retained,
        events,
        errors: app.errors(),
      }))
      throw error
    })
    assert.equal(
      (await app.host.stats()).length,
      2,
    )
    const after = await app.host.stats()

    for (const before of states) {
      const current = after.find(state => state.id === before.id)
      assert.ok(current)
      assert.equal(
        current.input.filter(input => input.id === before.input[0]?.id).length,
        1,
      )
    }
  },
)

test(
  'a tagged Hydra reply is applied while its task has a helper lease',
  async t => {
    const app = await fixtureApplication({
      t,
      built: false,
    })
    await app.start()
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
        'task',
        'create',
        '--key',
        'leased',
        '--title',
        'Leased task',
      ],
    })
    const task = Object.values(app.state().cards).find(card => card.key === 'leased')
    assert.ok(task)
    const lease = join(
      app.home,
      'hydras/default',
      `helper-lease-${encodeURIComponent(task.id)}.json`,
    )
    writeFileSync(
      lease,
      JSON.stringify({
        actor: 'helper:fixture',
        holders: [
          {
            id: 'fixture',
            pid: process.pid,
            durable: true,
          },
        ],
      }),
    )
    await app.cli({
      args: [
        'hydra',
        'send',
        '--text',
        'Report on the task',
      ],
    })
    await until({ check: async () => (await app.host.stats())[0]?.input.length === 1 })
    const session = (await app.host.stats())[0]!
    await app.host.control({
      kind: 'event',
      nativeId: session.id,
      event: {
        type: 'text',
        id: 'reply',
        text: `${taskMention({
          id: task.id,
          title: task.title,
        })} The work is ready.`,
      },
    })
    await app.host.control({
      kind: 'event',
      nativeId: session.id,
      event: {
        type: 'result',
        turn: session.turn!,
        inputIds: session.input.map(input => input.id),
        status: 'completed',
        queued: 0,
      },
    })
    await until({ check: () => app.state().cards[task.id]?.notes?.some(note => note.source === 'hydra') === true })
    assert.equal(
      app.state().cards.$hydra?.sessionActivity,
      'finished',
    )
    await assert.rejects(app.cli({
      args: [
        'task',
        'rename',
        task.id,
        '--title',
        'Changed',
      ],
    }))
  },
)

test(
  'one unavailable session folder does not block recovery of another session',
  async t => {
    const app = await fixtureApplication({
      t,
      built: false,
    })
    const firstFolder = join(
      app.root,
      'first-work',
    )
    mkdirSync(firstFolder)
    const server = await app.start()
    await app.cli({
      args: [
        'hydra',
        'set',
        '--helper',
        'off',
      ],
    })

    for (const [
      key,
      folder,
    ] of [
        [
          'first',
          firstFolder,
        ],
        [
          'second',
          app.folder,
        ],
      ]) {
      await app.cli({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
          '--folder',
          folder,
          '--brief',
          'Finish',
        ],
      })
      await app.cli({
        args: [
          'task',
          'start',
          key,
          '--via',
          'pnyx',
          '--harness',
          'codex',
          '--model',
          'fixture',
          '--folder',
          folder,
        ],
      })
    }

    await until({
      check: async () => {
        const states = await app.host.stats()

        return states.filter(state => state.input.length === 1).length === 2
      },
    })
    const sessions = await app.host.stats()
    server.child.kill('SIGKILL')
    await server.exited

    for (const state of sessions) {
      await app.host.control({
        kind: 'event',
        nativeId: state.id,
        event: {
          type: 'result',
          turn: state.turn!,
          inputIds: state.input.map(input => input.id),
          status: 'completed',
          queued: 0,
        },
      })
    }

    const observer = await app.host.connect()
    t.after(() => observer.detach())
    const cards = Object.values(app.state().cards)
    const firstId = cards.find(card => card.key === 'first')?.agent?.sessionId
    const secondId = cards.find(card => card.key === 'second')?.agent?.sessionId
    assert.ok(firstId && secondId)

    const facts = async ({ id }: { id: string }) => {
      const session = observer.ready.sessions.find(item => item.nativeId === id)
      assert.ok(session)

      return (await snapshot({
        client: observer,
        ref: session.ref,
      })).pendingFacts
    }

    await until({ check: async () => (await facts({ id: firstId })).some(fact => fact.event.type === 'turn-ended') })
    await until({ check: async () => (await facts({ id: secondId })).some(fact => fact.event.type === 'turn-ended') })
    rmSync(
      firstFolder,
      { recursive: true },
    )
    await app.start()
    await until({ check: async () => (await facts({ id: secondId })).length === 0 })
    const activity = ({ key }: { key: string }) => Object.values(app.state().cards)
      .find(card => card.key === key)?.sessionActivity
    await until({ check: () => activity({ key: 'second' }) === 'finished' })
    assert.ok((await facts({ id: firstId })).some(fact => fact.event.type === 'turn-ended'))
    mkdirSync(firstFolder)
    await until({ check: async () => (await facts({ id: firstId })).length === 0 })
    await until({ check: () => activity({ key: 'first' }) === 'finished' }).catch(error => {
      t.diagnostic(`first session activity: ${activity({ key: 'first' })}`)
      throw error
    })
  },
)
