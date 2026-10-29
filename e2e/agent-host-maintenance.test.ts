import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { payload } from '#agent-host/fixtures/bundle.ts'
import { stageBundle, validateBundle } from '#agent-host/bundle.ts'
import { selectBundle } from '#agent-host/install.ts'
import { replaceNative } from '#setup/native-maintenance.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import type { HostClient } from '#agent-host/client.ts'
import type { Result } from '#agent-host/protocol.ts'
import { fixtureHost, controlledSession, snapshot, until } from '#agent-host/fixtures/harness.ts'

const call = async ({
  client,
  operation,
}: {
  client: HostClient
  operation: Parameters<HostClient['call']>[0]['operation']
}) => client.call({
  id: randomUUID(),
  operation,
})

const maintenance = ({ result }: { result: Result }) => {
  assert.equal(
    result.kind,
    'maintenance',
  )

  if (result.kind !== 'maintenance') {
    throw new Error('Missing maintenance status')
  }

  return result.status
}

test(
  'drain preserves admitted turns and final close facts until their application acknowledgements',
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-maintenance-'))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const host = await fixtureHost({
      t,
      directory: root,
    })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    const inputs = [
      'first',
      'carried',
    ].map(text => ({
      id: randomUUID(),
      text,
      images: [],
    }))

    for (const input of inputs) {
      assert.equal(
        (await call({
          client,
          operation: {
            kind: 'input',
            ref: session.ref,
            controller: session.token,
            input,
          },
        })).kind,
        'input',
      )
    }

    await until({ check: async () => (await host.stats())[0]!.input.length === 2 })
    const initial = maintenance({
      result: await call({
        client,
        operation: {
          kind: 'drain',
          controller: session.hostToken,
        },
      }),
    })
    assert.ok(initial.drain)

    for (const operation of [
      {
        kind: 'input' as const,
        input: {
          id: randomUUID(),
          text: 'post-drain steering',
          images: [],
        },
      },
      {
        kind: 'context' as const,
        text: 'changed',
      },
      {
        kind: 'set' as const,
        setting: 'effort',
        value: 'high',
      },
      {
        kind: 'close' as const,
        expectedIdle: false,
      },
    ]) {
      const result = await call({
        client,
        operation: {
          ...operation,
          ref: session.ref,
          controller: session.token,
        },
      })
      assert.ok(
        result.kind === 'error' && result.code === 'DRAINING',
        JSON.stringify(result),
      )
    }

    const shut = () => call({
      client,
      operation: {
        kind: 'shutdown',
        controller: session.hostToken,
        drain: initial.drain!,
        when: 'quiescent',
      },
    })
    assert.ok(maintenance({ result: await shut() }).blockers.length)
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'result',
        turn: 'first-turn',
        inputIds: [inputs[0]!.id],
        status: 'completed',
        queued: 1,
      },
    })
    assert.ok(maintenance({ result: await shut() }).blockers.some(blocker => blocker.reasons.some(reason => reason.includes('Native turns'))))
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'result',
        turn: 'carried-turn',
        inputIds: [inputs[1]!.id],
        status: 'completed',
        queued: 0,
      },
    })
    let retained = await snapshot({
      client,
      ref: session.ref,
    })
    assert.ok(retained.pendingFacts.some(fact => fact.event.type === 'turn-ended'))
    assert.ok(maintenance({ result: await shut() }).blockers.some(blocker => blocker.reasons.some(reason => reason.includes('acknowledgement'))))
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    assert.equal(
      (await client.acknowledge({
        ref: session.ref,
        controller: session.token,
        through: retained.pendingFacts.at(-1)!.seq,
      })).kind,
      'ok',
    )
    const closing = maintenance({ result: await shut() })
    assert.ok(closing.blockers.some(blocker => blocker.reasons.some(reason => reason.includes('acknowledgement'))))
    retained = await snapshot({
      client,
      ref: session.ref,
    })
    assert.ok(retained.pendingFacts.some(fact => fact.event.type === 'ended'))
    client.detach()
    const resumed = await host.connect()
    assert.equal(
      resumed.ready.instance,
      client.ready.instance,
    )
    assert.equal(
      resumed.ready.maintenance.mode,
      'draining',
    )
    const attached = await call({
      client: resumed,
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: session.ref,
        },
        expectedRevision: 1,
      },
    })
    assert.ok(attached.kind === 'attached')
    retained = await snapshot({
      client: resumed,
      ref: session.ref,
    })
    assert.equal(
      (await resumed.acknowledge({
        ref: session.ref,
        controller: attached.control.generation,
        through: retained.pendingFacts.at(-1)!.seq,
      })).kind,
      'ok',
    )
    const claim = await call({
      client: resumed,
      operation: {
        kind: 'attach',
        scope: { kind: 'host' },
        expectedRevision: 1,
      },
    })
    assert.ok(claim.kind === 'attached')
    assert.equal(
      (await call({
        client: resumed,
        operation: {
          kind: 'shutdown',
          controller: claim.control.generation,
          drain: initial.drain!,
          when: 'quiescent',
        },
      })).kind,
      'shutdown',
    )
    await host.exited
    const replacement = await fixtureHost({
      t,
      directory: root,
    })
    const next = await replacement.connect()
    assert.equal(
      next.ready.predecessor,
      client.ready.instance,
    )
    assert.equal(
      next.ready.sessions.length,
      0,
    )
    await controlledSession({
      host: replacement,
      client: next,
    })
  },
)

test(
  'background ownership, compaction and stale host controllers block maintenance',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    const initial = maintenance({
      result: await call({
        client,
        operation: {
          kind: 'drain',
          controller: session.hostToken,
        },
      }),
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'background',
        background: {
          knowledge: 'unknown',
          reason: 'fixture capability unavailable',
        },
      },
    })
    let state = maintenance({
      result: await call({
        client,
        operation: { kind: 'status' },
      }),
    })
    assert.ok(state.blockers.some(blocker => blocker.reasons.some(reason => reason.includes('Native turns'))))
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'background',
        background: {
          knowledge: 'known',
          tasks: [
            {
              id: 'background-tool',
              type: 'fixture',
            },
          ],
        },
      },
    })
    assert.ok(maintenance({
      result: await call({
        client,
        operation: {
          kind: 'shutdown',
          controller: session.hostToken,
          drain: initial.drain!,
          when: 'quiescent',
        },
      }),
    }).blockers.length)
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'background',
        background: {
          knowledge: 'known',
          tasks: [],
        },
      },
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'compaction',
        id: 'compact',
        state: 'running',
        trigger: 'manual',
      },
    })
    const retained = await snapshot({
      client,
      ref: session.ref,
    })
    await client.acknowledge({
      ref: session.ref,
      controller: session.token,
      through: retained.pendingFacts.at(-1)!.seq,
    })
    state = maintenance({
      result: await call({
        client,
        operation: {
          kind: 'shutdown',
          controller: session.hostToken,
          drain: initial.drain!,
          when: 'quiescent',
        },
      }),
    })
    assert.ok(state.blockers.some(blocker => blocker.reasons.some(reason => reason.includes('Native turns'))))
    const newer = await host.connect()
    assert.equal(
      (await call({
        client: newer,
        operation: {
          kind: 'attach',
          scope: { kind: 'host' },
          expectedRevision: 1,
        },
      })).kind,
      'attached',
    )
    const stale = await call({
      client,
      operation: {
        kind: 'shutdown',
        controller: session.hostToken,
        drain: initial.drain!,
        when: 'quiescent',
      },
    })
    assert.ok(stale.kind === 'error' && stale.code === 'STALE_CONTROLLER')
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
  },
)

for (const broken of [
  false,
  true,
]) {
  test(
    `replacement ${broken ? 'rolls back a failed candidate' : 'starts the verified candidate'} after clean exit`,
    async t => {
      const root = realpathSync(mkdtempSync('/tmp/pnyx-replacement-'))
      t.after(() => rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      ))
      const source = payload({ root })
      const entry = 'src/agent-host/fixtures/process.ts'
      const bundles = join(
        root,
        'bundles',
      )
      const previous = stageBundle({
        source,
        directory: bundles,
        build: 'previous',
        entry,
      })

      if (broken) {
        writeFileSync(
          join(
            source,
            entry,
          ),
          'throw new Error("Synthetic startup failure")\n',
        )
      }

      const candidate = stageBundle({
        source,
        directory: bundles,
        build: 'candidate',
        entry,
      })
      const runtime = join(
        root,
        'runtime',
      )
      mkdirSync(runtime)
      let current = await fixtureHost({
        t,
        directory: runtime,
        entry: join(
          previous,
          entry,
        ),
      })
      const client = await current.connect()
      const selected = join(
        root,
        'selected.json',
      )
      const marker = join(
        runtime,
        'maintenance.json',
      )
      selectBundle({
        path: selected,
        bundle: previous,
      })
      const result = await replaceNative({
        client,
        previous,
        candidate,
        selected,
        marker,
        ownerPath: join(
          runtime,
          'owner.json',
        ),
        runtime: {
          async stop() {
            if (current.child.exitCode === null && current.child.signalCode === null) {
              await current.control({ kind: 'stop' })
            }

            await current.exited
          },
          async start({ bundle }) {
            current = await fixtureHost({
              t,
              directory: runtime,
              entry: join(
                bundle,
                entry,
              ),
            })

            return current.connect()
          },
        },
      })
      assert.equal(
        result.state,
        broken ? 'rolled_back' : 'replaced',
      )
      assert.equal(
        JSON.parse(readFileSync(
          selected,
          'utf8',
        )).bundle,
        broken ? previous : candidate,
      )
      assert.equal(
        existsSync(marker),
        false,
      )
      assert.equal(
        validateBundle({ directory: previous }).build,
        'previous',
      )
      assert.equal(
        validateBundle({ directory: candidate }).build,
        'candidate',
      )
      const connected = await current.connect()
      assert.notEqual(
        connected.ready.instance,
        client.ready.instance,
      )
      assert.equal(
        connected.ready.predecessor,
        client.ready.instance,
      )
      await controlledSession({
        host: current,
        client: connected,
      })
    },
  )
}

test(
  'the real CLI exposes maintenance status and limits drain to the owner',
  async t => {
    const home = realpathSync(mkdtempSync('/tmp/pnyx-maintenance-cli-'))
    t.after(() => rmSync(
      home,
      {
        recursive: true,
        force: true,
      },
    ))
    const host = await fixtureHost({
      t,
      directory: join(
        home,
        'native',
      ),
    })
    const exec = promisify(execFile)
    const cli = ({
      args,
      actor = 'cli',
    }: {
      args: string[]
      actor?: string
    }) => exec(
      process.execPath,
      [
        join(
          import.meta.dirname,
          '..',
          'dist/cli/pnyx-axi.js',
        ),
        'native',
        ...args,
      ],
      {
        env: {
          ...process.env,
          PNYX_HOME: home,
          PNYX_ACTOR: actor,
          HOME: home,
        },
      },
    )
    const status = await cli({ args: ['status'] })
    assert.match(
      status.stdout,
      /mode: ready/,
    )
    await assert.rejects(
      cli({
        args: ['drain'],
        actor: 'worker:fixture',
      }),
      error => {
        assert.match(
          (error as Error & { stdout: string }).stdout,
          /OWNER_ONLY/,
        )

        return true
      },
    )
    const drained = await cli({ args: ['drain'] })
    assert.match(
      drained.stdout,
      /mode: draining/,
    )
    const client = await host.connect()
    assert.equal(
      client.ready.maintenance.mode,
      'draining',
    )
  },
)
