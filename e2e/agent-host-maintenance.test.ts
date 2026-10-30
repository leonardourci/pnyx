import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
  'manual stop defers for admitted work and unapplied outcomes, then closes an idle host',
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
    const shut = () => call({
      client,
      operation: {
        kind: 'shutdown',
        controller: session.hostToken,
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
    const retained = await snapshot({
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
    assert.equal(
      (await shut()).kind,
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

test(
  'the real CLI exposes idle status and limits stop to the owner',
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
        args: ['stop'],
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
    const stopped = await cli({ args: ['stop'] })
    assert.match(
      stopped.stdout,
      /kind: shutdown/,
    )
    await host.exited
  },
)
