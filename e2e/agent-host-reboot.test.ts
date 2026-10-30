import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureHost, controlledSession, snapshot } from '#agent-host/fixtures/harness.ts'
import { kernelBootIdentity } from '#agent-host/boot.ts'

const FIRST_BOOT = '11111111-1111-4111-8111-111111111111'
const NEXT_BOOT = '22222222-2222-4222-8222-222222222222'

test(
  'the production boot reader persists the kernel identity in native ownership',
  async t => {
    const host = await fixtureHost({ t })
    const owner = JSON.parse(readFileSync(
      join(
        host.root,
        'owner.json',
      ),
      'utf8',
    ))
    const identity = kernelBootIdentity()
    assert.ok(identity)
    assert.equal(
      owner.boot,
      identity,
    )
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    const saved = JSON.parse(readFileSync(
      join(
        host.root,
        'sessions',
        session.ref.id,
        'session.json',
      ),
      'utf8',
    ))
    assert.equal(
      saved.boot,
      identity,
    )
  },
)

for (const pair of [
  {
    before: FIRST_BOOT,
    after: FIRST_BOOT,
    label: 'same boot',
  },
  {
    before: null,
    after: NEXT_BOOT,
    label: 'unknown previous boot',
  },
  {
    before: FIRST_BOOT,
    after: null,
    label: 'unknown current boot',
  },
  {
    before: 'invalid',
    after: NEXT_BOOT,
    label: 'invalid previous identity',
  },
]) {
  test(
    `native recovery resumes without a cleanup fence with ${pair.label}`,
    async t => {
      const first = await fixtureHost({
        t,
        boot: pair.before,
      })
      const client = await first.connect()
      const session = await controlledSession({
        host: first,
        client,
      })
      first.child.kill('SIGKILL')
      await first.exited
      const next = await fixtureHost({
        t,
        directory: first.root,
        boot: pair.after,
      })
      const observer = await next.connect()
      const current = observer.ready.sessions[0]!
      assert.equal(
        current.phase,
        'closed',
      )
      assert.equal(
        current.recovery,
        'host_lost',
      )
      const claim = await observer.call({
        id: randomUUID(),
        operation: {
          kind: 'attach',
          scope: { kind: 'host' },
          expectedRevision: 0,
        },
      })
      assert.ok(claim.kind === 'attached')
      const resumed = await observer.call({
        id: randomUUID(),
        operation: {
          kind: 'open',
          controller: claim.control.generation,
          options: {
            ...session.options,
            resume: { nativeId: session.nativeId },
          },
        },
      })
      assert.ok(resumed.kind === 'opened')
      assert.equal(
        resumed.session.nativeId,
        session.nativeId,
      )
      assert.notEqual(
        resumed.session.ref.epoch,
        session.ref.epoch,
      )
      assert.deepEqual(
        (await next.stats()).map(state => state.input),
        [[]],
      )
    },
  )
}

for (const phase of [
  'live',
  'closed',
]) {
  test(
    `verified reboot settles ${phase} facts before cold resume and survives another host crash`,
    async t => {
      const first = await fixtureHost({
        t,
        boot: FIRST_BOOT,
      })
      const client = await first.connect()
      const session = await controlledSession({
        host: first,
        client,
      })
      await first.control({
        kind: 'event',
        nativeId: session.nativeId,
        event: {
          type: 'structured',
          value: 'retained result',
        },
      })

      if (phase === 'closed') {
        await client.call({
          id: randomUUID(),
          operation: {
            kind: 'close',
            ref: session.ref,
            controller: session.token,
            expectedIdle: false,
          },
        })
      }

      const original = await snapshot({
        client,
        ref: session.ref,
      })
      first.child.kill('SIGKILL')
      await first.exited
      const second = await fixtureHost({
        t,
        directory: first.root,
        boot: NEXT_BOOT,
      })
      const recovering = await second.connect()
      assert.equal(
        recovering.ready.sessions[0]!.recovery,
        'boot_changed',
      )
      second.child.kill('SIGKILL')
      await second.exited
      const third = await fixtureHost({
        t,
        directory: first.root,
        boot: NEXT_BOOT,
      })
      const current = await third.connect()
      assert.equal(
        current.ready.sessions[0]!.phase,
        'recovery_required',
      )
      const hostClaim = await current.call({
        id: randomUUID(),
        operation: {
          kind: 'attach',
          scope: { kind: 'host' },
          expectedRevision: 0,
        },
      })
      assert.ok(hostClaim.kind === 'attached')
      const open = () => current.call({
        id: randomUUID(),
        operation: {
          kind: 'open',
          controller: hostClaim.control.generation,
          options: {
            ...session.options,
            resume: { nativeId: session.nativeId },
          },
        },
      })
      const refused = await open()
      assert.ok(refused.kind === 'error' && refused.code === 'RECOVERY_REQUIRED')
      const claim = await current.call({
        id: randomUUID(),
        operation: {
          kind: 'attach',
          scope: {
            kind: 'session',
            ref: session.ref,
          },
          expectedRevision: 0,
        },
      })
      assert.ok(claim.kind === 'attached')
      const retained = await snapshot({
        client: current,
        ref: session.ref,
      })
      assert.deepEqual(
        retained.pendingFacts,
        original.pendingFacts,
      )
      const settled = await current.acknowledge({
        ref: session.ref,
        controller: claim.control.generation,
        through: retained.pendingFacts.at(-1)!.seq,
      })
      assert.ok(settled.kind === 'ok' && settled.session?.phase === 'closed')
      const resumed = await open()
      assert.ok(resumed.kind === 'opened')
      assert.equal(
        resumed.session.nativeId,
        session.nativeId,
      )
      assert.notEqual(
        resumed.session.ref.epoch,
        session.ref.epoch,
      )
      assert.deepEqual(
        (await third.stats()).map(state => state.input),
        [[]],
      )
    },
  )
}
