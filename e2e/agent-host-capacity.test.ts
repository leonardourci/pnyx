import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureHost, snapshot } from '#agent-host/fixtures/harness.ts'
import type { HostClient } from '#agent-host/client.ts'

const SESSION_LIMIT = 64
const COMPLETED_SESSIONS = 66

async function controller({ client }: { client: HostClient }) {
  const attached = await client.call({
    id: randomUUID(),
    operation: {
      kind: 'attach',
      scope: { kind: 'host' },
      expectedRevision: client.ready.hostControllerRevision,
    },
  })
  assert.ok(attached.kind === 'attached')

  return attached.control.generation
}

async function open({
  client,
  token,
  cwd,
}: {
  client: HostClient
  token: string
  cwd: string
}) {
  const opened = await client.call({
    id: randomUUID(),
    operation: {
      kind: 'open',
      controller: token,
      options: {
        provider: 'claude-code',
        cwd,
        settings: {},
        environment: {},
      },
    },
  })
  assert.equal(
    opened.kind,
    'opened',
    JSON.stringify(opened),
  )
  assert.ok(opened.kind === 'opened' && opened.session.nativeId)
  const attached = await client.call({
    id: randomUUID(),
    operation: {
      kind: 'attach',
      scope: {
        kind: 'session',
        ref: opened.session.ref,
      },
      expectedRevision: 0,
    },
  })
  assert.ok(attached.kind === 'attached')

  return {
    ref: opened.session.ref,
    nativeId: opened.session.nativeId,
    token: attached.control.generation,
  }
}

test(
  'acknowledged closed sessions leave room for more than 64 native opens',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const token = await controller({ client })
    const completed = []

    for (let index = 0; index < COMPLETED_SESSIONS; index++) {
      const session = await open({
        client,
        token,
        cwd: host.root,
      })
      completed.push(session.ref)
      assert.equal(
        (await client.call({
          id: randomUUID(),
          operation: {
            kind: 'close',
            expectedIdle: false,
            ref: session.ref,
            controller: session.token,
          },
        })).kind,
        'ok',
      )
      const ended = await snapshot({
        client,
        ref: session.ref,
      })
      assert.equal(
        ended.snapshot.session.phase,
        'closed',
      )
      const last = ended.pendingFacts.at(-1)
      assert.ok(last)
      assert.equal(
        (await client.acknowledge({
          ref: session.ref,
          controller: session.token,
          through: last.seq,
        })).kind,
        'ok',
      )
    }

    await open({
      client,
      token,
      cwd: host.root,
    })
    const ref = completed[0]
    assert.ok(ref)
    const reconnected = await host.connect()
    assert.ok(reconnected.ready.sessions.some(session => session.ref.id === ref.id))
    const retained = await snapshot({
      client: reconnected,
      ref,
    })
    assert.equal(
      retained.snapshot.session.phase,
      'closed',
    )
    assert.deepEqual(
      retained.pendingFacts,
      [],
    )
    assert.ok(existsSync(join(
      host.root,
      'sessions',
      ref.id,
      'session.json',
    )))
    assert.ok(existsSync(join(
      host.root,
      'sessions',
      ref.id,
      'outbox.jsonl',
    )))
  },
)

test(
  'live and terminal sessions with unapplied facts still fill the native limit',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const token = await controller({ client })
    const sessions = []

    for (let index = 0; index < SESSION_LIMIT; index++) {
      sessions.push(await open({
        client,
        token,
        cwd: host.root,
      }))
    }

    const refused = () => client.call({
      id: randomUUID(),
      operation: {
        kind: 'open',
        controller: token,
        options: {
          provider: 'claude-code',
          cwd: host.root,
          settings: {},
          environment: {},
        },
      },
    })
    assert.deepEqual(
      await refused(),
      {
        kind: 'error',
        code: 'SESSION_LIMIT',
        message: 'The native host reached its session limit',
      },
    )

    const failed = sessions[0]
    const closed = sessions[1]
    assert.ok(failed && closed)
    await host.control({
      kind: 'event',
      nativeId: failed.nativeId,
      event: {
        type: 'ended',
        reason: 'failed',
        error: 'Synthetic provider failure',
      },
    })

    for (const session of sessions.slice(1)) {
      await client.call({
        id: randomUUID(),
        operation: {
          kind: 'close',
          expectedIdle: false,
          ref: session.ref,
          controller: session.token,
        },
      })
    }

    assert.deepEqual(
      await refused(),
      {
        kind: 'error',
        code: 'SESSION_LIMIT',
        message: 'The native host reached its session limit',
      },
    )
    const ended = await snapshot({
      client,
      ref: failed.ref,
    })
    assert.equal(
      ended.snapshot.session.phase,
      'failed',
    )
    assert.ok(ended.pendingFacts.some(fact => fact.event.type === 'ended'))
    const last = ended.pendingFacts.at(-1)
    assert.ok(last)
    assert.equal(
      (await client.acknowledge({
        ref: failed.ref,
        controller: failed.token,
        through: last.seq,
      })).kind,
      'ok',
    )
    await open({
      client,
      token,
      cwd: host.root,
    })
    const retained = await snapshot({
      client,
      ref: closed.ref,
    })
    assert.equal(
      retained.snapshot.session.phase,
      'closed',
    )
    assert.ok(retained.pendingFacts.some(fact => fact.event.type === 'ended'))
  },
)
