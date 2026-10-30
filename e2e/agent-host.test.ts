import { createConnection, createServer } from 'node:net'
import { connectHost } from '#agent-host/client.ts'
import { deferred } from '#agent-host/deferred.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureHost, controlledSession, snapshot, until } from '#agent-host/fixtures/harness.ts'
import type { ToClient } from '#agent-host/protocol.ts'
import { MAX_FRAME_BYTES } from '#agent-host/protocol.ts'
import { durableEvent } from '#agent-host/output.ts'

const WAIT_MS = 5000
const PRESSURE_FRAME_BYTES = 1024 * 1024
const PRESSURE_EVENT_COUNT = 64

test(
  'the native host deduplicates named calls and input manifests across reader detach',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    const repeated = await client.call({
      id: session.openId,
      operation: {
        kind: 'open',
        controller: session.hostToken,
        options: session.options,
      },
    })
    assert.ok(repeated.kind === 'opened')
    assert.equal(
      repeated.session.nativeId,
      session.nativeId,
    )
    const conflict = await client.call({
      id: session.openId,
      operation: {
        kind: 'open',
        controller: session.hostToken,
        options: {
          ...session.options,
          context: 'changed',
        },
      },
    })
    assert.ok(conflict.kind === 'error' && conflict.code === 'CONFLICTING_ID')
    const outbox = join(
      host.root,
      'sessions',
      session.ref.id,
      'outbox.jsonl',
    )
    const savedBeforeInput = readFileSync(
      outbox,
      'utf8',
    )
    const input = {
      id: randomUUID(),
      text: 'Hello',
      images: [],
    }
    const send = {
      kind: 'input' as const,
      ref: session.ref,
      controller: session.token,
      input,
    }
    assert.equal(
      (await client.call({
        id: 'input-call',
        operation: send,
      })).kind,
      'input',
    )
    assert.equal(
      (await client.call({
        id: 'input-call',
        operation: send,
      })).kind,
      'input',
    )
    await until({ check: async () => (await host.stats())[0]?.input.length === 1 })
    const admitted = await snapshot({
      client,
      ref: session.ref,
    })
    assert.ok(admitted.snapshot.admittedInputIds.includes(input.id))
    assert.equal(
      readFileSync(
        outbox,
        'utf8',
      ),
      savedBeforeInput,
    )
    const repeatedInput = await client.call({
      id: randomUUID(),
      operation: send,
    })
    assert.equal(
      repeatedInput.kind,
      'input',
    )
    const changedText = await client.call({
      id: randomUUID(),
      operation: {
        ...send,
        input: {
          ...input,
          text: 'Changed',
        },
      },
    })
    assert.ok(changedText.kind === 'error' && changedText.code === 'CONFLICTING_INPUT')
    const changedImages = await client.call({
      id: randomUUID(),
      operation: {
        ...send,
        input: {
          ...input,
          images: [
            {
              path: join(
                host.root,
                'image.png',
              ),
              digest: 'synthetic',
              mediaType: 'image/png',
            },
          ],
        },
      },
    })
    assert.ok(changedImages.kind === 'error' && changedImages.code === 'CONFLICTING_INPUT')
    assert.equal(
      (await host.stats())[0]!.input.length,
      1,
    )
    client.detach()
    const next = await host.connect()
    assert.equal(
      next.ready.sessions[0]?.nativeId,
      session.nativeId,
    )
    const attach = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: session.ref,
        },
        expectedRevision: 1,
      },
    })
    assert.ok(attach.kind === 'attached')
    assert.equal(
      (await next.call({
        id: 'input-call',
        operation: {
          ...send,
          controller: attach.control.generation,
        },
      })).kind,
      'input',
    )
    assert.equal(
      (await host.stats()).length,
      1,
    )
    assert.equal(
      (await host.stats())[0]!.input.length,
      1,
    )
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    const busy = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'close',
        ref: session.ref,
        controller: attach.control.generation,
        expectedIdle: true,
      },
    })
    assert.ok(busy.kind === 'error' && busy.code === 'NATIVE_BUSY')
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    const closed = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'close',
        ref: session.ref,
        controller: attach.control.generation,
        expectedIdle: false,
      },
    })
    assert.equal(
      closed.kind,
      'ok',
    )
    assert.equal(
      (await host.stats())[0]!.closed,
      true,
    )
  },
)

test(
  'a controller attach waits for an admitted native mutation and fences old distinct controls and acknowledgements',
  async t => {
    const host = await fixtureHost({ t })
    const old = await host.connect()
    const session = await controlledSession({
      host,
      client: old,
    })
    const next = await host.connect()
    const setting = old.call({
      id: 'held-setting',
      operation: {
        kind: 'set',
        ref: session.ref,
        controller: session.token,
        setting: 'effort',
        value: 'hold',
      },
    })
    await until({ check: async () => (await host.stats())[0]?.settings.length === 1 })
    const barrier = next.call({
      id: 'barrier',
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: session.ref,
        },
        expectedRevision: 1,
      },
    })
    await until({
      check: async () => {
        const status = await next.result({ requestId: 'barrier' })

        return status.kind === 'error' && status.code === 'IN_FLIGHT'
      },
    })
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    await host.control({
      kind: 'release',
      nativeId: session.nativeId,
    })
    assert.equal(
      (await setting).kind,
      'ok',
    )
    const grant = await barrier
    assert.ok(grant.kind === 'attached')
    const staleSet = await old.call({
      id: 'late-set',
      operation: {
        kind: 'set',
        ref: session.ref,
        controller: session.token,
        setting: 'effort',
        value: 'high',
      },
    })
    assert.ok(staleSet.kind === 'error' && staleSet.code === 'STALE_CONTROLLER')
    const staleContext = await old.call({
      id: 'late-context',
      operation: {
        kind: 'context',
        ref: session.ref,
        controller: session.token,
        text: 'stale',
      },
    })
    assert.ok(staleContext.kind === 'error' && staleContext.code === 'STALE_CONTROLLER')
    const staleClose = await old.call({
      id: 'late-close',
      operation: {
        kind: 'close',
        ref: session.ref,
        controller: session.token,
        expectedIdle: false,
      },
    })
    assert.ok(staleClose.kind === 'error' && staleClose.code === 'STALE_CONTROLLER')
    const staleAck = await old.acknowledge({
      ref: session.ref,
      controller: session.token,
      through: 0,
    })
    assert.ok(staleAck.kind === 'error' && staleAck.code === 'STALE_CONTROLLER')
    const delayedAttach = await old.call({
      id: 'late-attach',
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: session.ref,
        },
        expectedRevision: 1,
      },
    })
    assert.ok(delayedAttach.kind === 'error' && delayedAttach.code === 'STALE_REVISION')
    assert.deepEqual(
      (await host.stats())[0]!.settings,
      ['effort=hold'],
    )
    assert.equal(
      (await host.stats())[0]!.context,
      'original',
    )
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    const observer = await host.connect()
    const refused = await observer.call({
      id: randomUUID(),
      operation: {
        kind: 'close',
        ref: session.ref,
        controller: grant.control.generation,
        expectedIdle: false,
      },
    })
    assert.ok(refused.kind === 'error' && refused.code === 'STALE_CONTROLLER')
  },
)

test(
  'a lost in-flight reply reconciles by request ID after the native mutation settles',
  async t => {
    const host = await fixtureHost({ t })
    const old = await host.connect()
    const session = await controlledSession({
      host,
      client: old,
    })
    const requestId = randomUUID()
    const operation = {
      kind: 'set' as const,
      ref: session.ref,
      controller: session.token,
      setting: 'effort',
      value: 'hold',
    }
    const setting = old.call({
      id: requestId,
      operation,
    })
    const lostReply = assert.rejects(
      setting,
      /connection ended/,
    )
    await until({ check: async () => (await host.stats())[0]?.settings.length === 1 })
    old.detach()
    await lostReply
    const next = await host.connect()
    const pending = await next.result({ requestId })
    assert.ok(pending.kind === 'error' && pending.code === 'IN_FLIGHT')
    const attached = next.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: session.ref,
        },
        expectedRevision: 1,
      },
    })
    await host.control({
      kind: 'release',
      nativeId: session.nativeId,
    })
    const grant = await attached
    assert.ok(grant.kind === 'attached')
    const replayed = await next.call({
      id: requestId,
      operation: {
        ...operation,
        controller: grant.control.generation,
      },
    })
    assert.equal(
      replayed.kind,
      'ok',
    )
    assert.deepEqual(
      (await host.stats())[0]!.settings,
      ['effort=hold'],
    )
  },
)

test(
  'memory-only acknowledgements allow original fact identities to replay after host loss',
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
        type: 'structured',
        value: 'applied',
      },
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'structured',
        value: 'pending',
      },
    })
    const baseline = await snapshot({
      client,
      ref: session.ref,
    })
    const applied = baseline.pendingFacts.find(fact => fact.event.type === 'structured' && fact.event.value === 'applied')
    assert.ok(applied)
    const acknowledged = await client.acknowledge({
      ref: session.ref,
      controller: session.token,
      through: applied.seq,
    })
    assert.equal(
      acknowledged.kind,
      'ok',
    )
    const retained = await snapshot({
      client,
      ref: session.ref,
    })
    assert.equal(
      retained.pendingFacts.length,
      1,
    )
    assert.ok(retained.pendingFacts[0]?.event.type === 'structured' && retained.pendingFacts[0].event.value === 'pending')
    host.child.kill('SIGKILL')
    await host.exited
    const restarted = await fixtureHost({
      t,
      directory: host.root,
    })
    const next = await restarted.connect()
    const restored = await snapshot({
      client: next,
      ref: session.ref,
    })
    assert.deepEqual(
      restored.pendingFacts,
      baseline.pendingFacts,
    )
    assert.ok(restored.viewThrough >= applied.seq)
    await restarted.control({ kind: 'stop' })
    await restarted.exited
  },
)

test(
  'a reconnect snapshot retains the original critical result and time after view expiry without acknowledging it',
  async t => {
    const host = await fixtureHost({
      t,
      pressure: true,
    })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    const frames: ToClient[] = []
    client.subscribe({
      receive: ({ frame }) => {
        frames.push(frame)
      },
    })
    await snapshot({
      client,
      ref: session.ref,
    })
    await client.call({
      id: randomUUID(),
      operation: {
        kind: 'input',
        ref: session.ref,
        controller: session.token,
        input: {
          id: 'message',
          text: 'Hello',
          images: [],
        },
      },
    })
    await until({ check: async () => (await host.stats())[0]?.input.length === 1 })
    const active = await snapshot({
      client,
      ref: session.ref,
    })
    const turn = active.snapshot.native!.work.runningTurns[0]!
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'structured',
        value: { answer: 42 },
      },
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'result',
        turn,
        inputIds: ['message'],
        status: 'completed',
        final: 'Final result',
        queued: 0,
      },
    })
    await until({ check: () => frames.some(frame => frame.type === 'event' && typeof frame.event === 'object' && frame.event.type === 'turn-ended') })
    const completed = await snapshot({
      client,
      ref: session.ref,
    })
    const original = completed.pendingFacts.find(fact => fact.event.type === 'turn-ended')!
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'compaction',
        id: 'retained-compact',
        trigger: 'manual',
        state: 'done',
      },
    })
    client.detach()
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'text',
        id: 'one',
        text: '1',
      },
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'text',
        id: 'two',
        text: '2',
      },
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'text',
        id: 'three',
        text: '3',
      },
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'text',
        id: 'four',
        text: '4',
      },
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'text',
        id: 'five',
        text: '5',
      },
    })
    const next = await host.connect()
    const replay: ToClient[] = []
    next.subscribe({
      receive: ({ frame }) => {
        replay.push(frame)
      },
    })
    const baseline = await snapshot({
      client: next,
      ref: session.ref,
      after: 0,
    })
    assert.ok(replay.some(frame => frame.type === 'resync'))
    assert.deepEqual(
      baseline.pendingFacts.find(fact => fact.event.type === 'turn-ended'),
      original,
    )
    assert.ok(original.event.type === 'turn-ended')
    assert.equal(
      original.event.outcome.result,
      'Final result',
    )
    assert.deepEqual(
      original.event.outcome.structured,
      { answer: 42 },
    )
    assert.ok(baseline.viewThrough > original.seq)
    assert.equal(
      baseline.snapshot.retention,
      'degraded',
    )
    const denied = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: session.ref,
        },
        expectedRevision: 1,
      },
    })
    assert.ok(denied.kind === 'attached')
    const refused = await next.acknowledge({
      ref: session.ref,
      controller: denied.control.generation,
      through: original.seq,
    })
    assert.ok(refused.kind === 'error' && refused.code === 'INVALID_ACK')
    const pressure = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'input',
        ref: session.ref,
        controller: denied.control.generation,
        input: {
          id: 'after-pressure',
          text: 'Wait',
          images: [],
        },
      },
    })
    assert.ok(pressure.kind === 'error' && pressure.code === 'RETENTION_PRESSURE')
    const redelivered = await snapshot({
      client: next,
      ref: session.ref,
    })
    const redraw = await next.acknowledge({
      ref: session.ref,
      controller: denied.control.generation,
      through: redelivered.viewThrough,
    })
    assert.ok(redraw.kind === 'error' && redraw.code === 'INVALID_ACK')
    const high = redelivered.pendingFacts.at(-1)!.seq
    const ack = await next.acknowledge({
      ref: session.ref,
      controller: denied.control.generation,
      through: high,
    })
    assert.equal(
      ack.kind,
      'ok',
    )
    const settled = await snapshot({
      client: next,
      ref: session.ref,
    })
    assert.deepEqual(
      settled.pendingFacts,
      [],
    )
    assert.equal(
      settled.snapshot.retention,
      'healthy',
    )
    const admitted = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'input',
        ref: session.ref,
        controller: denied.control.generation,
        input: {
          id: 'after-pressure',
          text: 'Wait',
          images: [],
        },
      },
    })
    assert.equal(
      admitted.kind,
      'input',
    )
    await until({ check: async () => (await host.stats())[0]?.input.length === 2 })
  },
)

test(
  'reconnecting restores the latest partial usage updates without waiting for another native event',
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
        type: 'usage',
        used: 120,
        window: 1000,
        cost: 0.25,
        limits: [
          {
            label: 'weekly',
            used: 30,
          },
        ],
      },
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'usage',
        used: 180,
        cost: 0.5,
      },
    })
    client.detach()
    const next = await host.connect()
    const baseline = await snapshot({
      client: next,
      ref: session.ref,
    })
    assert.deepEqual(
      baseline.snapshot.usage,
      {
        used: 180,
        window: 1000,
        cost: 0.5,
        limits: [
          {
            label: 'weekly',
            used: 30,
          },
        ],
      },
    )
  },
)

test(
  'secret answers survive client loss as value-free stable receipts and reach the native continuation once',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    await client.call({
      id: randomUUID(),
      operation: {
        kind: 'input',
        ref: session.ref,
        controller: session.token,
        input: {
          id: 'question-input',
          text: 'Ask',
          images: [],
        },
      },
    })
    await until({ check: async () => (await host.stats())[0]?.input.length === 1 })
    const secret = 'fixture-password-do-not-record'
    const asked = host.control({
      kind: 'ask',
      nativeId: session.nativeId,
      expected: secret,
    })
    const observer = await host.connect()
    await until({
      check: async () => (await snapshot({
        client: observer,
        ref: session.ref,
      })).pendingFacts
        .some(fact => fact.event.type === 'permission'),
    })
    const answerId = randomUUID()
    const requestId = randomUUID()
    const decision = await client.call({
      id: requestId,
      operation: {
        kind: 'answer',
        ref: session.ref,
        controller: session.token,
        answerId,
        permission: 'native-ask',
        decision: {
          behavior: 'allow',
          values: { password: secret },
        },
      },
    })
    assert.deepEqual(
      decision,
      {
        kind: 'answer',
        receipt: {
          answerId,
          permission: 'native-ask',
          phase: 'submitted',
        },
      },
    )
    await asked
    client.detach()
    const next = await host.connect()
    assert.deepEqual(
      await next.result({ requestId }),
      decision,
    )
    const current = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: session.ref,
        },
        expectedRevision: 1,
      },
    })
    assert.ok(current.kind === 'attached')
    const repeated = await next.call({
      id: requestId,
      operation: {
        kind: 'answer',
        ref: session.ref,
        controller: current.control.generation,
        answerId,
        permission: 'native-ask',
        decision: { behavior: 'allow' },
      },
    })
    assert.deepEqual(
      repeated,
      decision,
    )
    assert.equal(
      (await host.stats())[0]!.answers,
      1,
    )
    assert.equal(
      (await host.stats())[0]!.valueMatched,
      true,
    )
    const baseline = await snapshot({
      client: next,
      ref: session.ref,
    })
    assert.deepEqual(
      baseline.snapshot.native?.answers,
      [
        {
          answerId,
          permission: 'native-ask',
          phase: 'submitted',
        },
      ],
    )
    assert.deepEqual(
      baseline.snapshot.native?.permissions,
      [],
    )
    assert.ok(baseline.pendingFacts.some(fact => fact.event.type === 'answer' && fact.event.receipt.answerId === answerId))
    assert.equal(
      JSON.stringify(baseline).includes(secret),
      false,
    )
    const directory = join(
      host.root,
      'sessions',
      session.ref.id,
    )
    const stored = readdirSync(directory).map(name => readFileSync(
      join(
        directory,
        name,
      ),
      'utf8',
    ))
      .join('')
    assert.equal(
      stored.includes(secret),
      false,
    )
    const absent = await next.result({ requestId: 'never-accepted-answer' })
    assert.ok(absent.kind === 'error' && absent.code === 'NOT_RECEIVED')
  },
)

test(
  'a second host cannot replace a live owner and an actual host crash exposes old facts without reopening agents',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    await client.call({
      id: randomUUID(),
      operation: {
        kind: 'input',
        ref: session.ref,
        controller: session.token,
        input: {
          id: 'before-crash',
          text: 'Hello',
          images: [],
        },
      },
    })
    await until({ check: async () => (await host.stats())[0]?.input.length === 1 })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'structured',
        value: { result: 'retained before host loss' },
      },
    })
    const baseline = await snapshot({
      client,
      ref: session.ref,
    })
    assert.ok(baseline.pendingFacts.some(fact => fact.event.type === 'structured'))
    await assert.rejects(
      fixtureHost({
        t,
        directory: host.root,
      }),
      /ALREADY_RUNNING/,
    )
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    host.child.kill('SIGKILL')
    await host.exited
    const restarted = await fixtureHost({
      t,
      directory: host.root,
    })
    const next = await restarted.connect()
    assert.equal(
      next.ready.ledger,
      'recovery_required',
    )
    assert.equal(
      next.ready.sessions[0]?.phase,
      'recovery_required',
    )
    const restored = await snapshot({
      client: next,
      ref: session.ref,
    })
    assert.deepEqual(
      restored.pendingFacts,
      baseline.pendingFacts.filter(fact => durableEvent({ event: fact.event })),
    )
    assert.deepEqual(
      await restarted.stats(),
      [],
    )
    const unknown = await next.result({ requestId: session.openId })
    assert.ok(unknown.kind === 'error' && unknown.code === 'UNKNOWN')
    const attached = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: { kind: 'host' },
        expectedRevision: 0,
      },
    })
    assert.ok(attached.kind === 'attached')
    const forbidden = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'open',
        controller: attached.control.generation,
        options: session.options,
      },
    })
    assert.ok(forbidden.kind === 'error' && forbidden.code === 'RECOVERY_REQUIRED')
    assert.deepEqual(
      await restarted.stats(),
      [],
    )
    await restarted.control({ kind: 'stop' })
    await restarted.exited
  },
)

test(
  'an empty host restart reports lost request certainty without inventing unresolved native ownership',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const requestId = randomUUID()
    const attached = await client.call({
      id: requestId,
      operation: {
        kind: 'attach',
        scope: { kind: 'host' },
        expectedRevision: 0,
      },
    })
    assert.equal(
      attached.kind,
      'attached',
    )
    host.child.kill('SIGKILL')
    await host.exited
    const restarted = await fixtureHost({
      t,
      directory: host.root,
    })
    const next = await restarted.connect()
    assert.equal(
      next.ready.ledger,
      'recovery_required',
    )
    assert.deepEqual(
      next.ready.sessions,
      [],
    )
    const result = await next.result({ requestId })
    assert.ok(result.kind === 'error' && result.code === 'UNKNOWN')
    await controlledSession({
      host: restarted,
      client: next,
    })
    assert.equal(
      (await restarted.stats()).length,
      1,
    )
    await restarted.control({ kind: 'stop' })
    await restarted.exited
  },
)

test(
  'a failed host start preserves an unrelated socket-path file and incomplete owner claim',
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-host-path-'))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const socket = join(
      root,
      'host.sock',
    )
    writeFileSync(
      socket,
      'unrelated file',
    )
    await assert.rejects(
      fixtureHost({
        t,
        directory: root,
      }),
      /SOCKET_PATH/,
    )
    assert.equal(
      readFileSync(
        socket,
        'utf8',
      ),
      'unrelated file',
    )
    rmSync(socket)
    const lock = join(
      root,
      'owner.json',
    )
    writeFileSync(
      lock,
      '',
    )
    await assert.rejects(
      fixtureHost({
        t,
        directory: root,
      }),
      /STARTING/,
    )
    assert.equal(
      readFileSync(
        lock,
        'utf8',
      ),
      '',
    )
  },
)

test(
  'an unsettled native mutation times out explicitly before takeover and blocks later mutations until it settles',
  async t => {
    const host = await fixtureHost({
      t,
      slowControls: true,
    })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    const held = await client.call({
      id: 'slow-set',
      operation: {
        kind: 'set',
        ref: session.ref,
        controller: session.token,
        setting: 'effort',
        value: 'hold',
      },
    })
    assert.ok(held.kind === 'error' && held.code === 'CONTROL_UNKNOWN')
    const next = await host.connect()
    const grant = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: session.ref,
        },
        expectedRevision: 1,
      },
    })
    assert.ok(grant.kind === 'attached')
    const blocked = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'context',
        ref: session.ref,
        controller: grant.control.generation,
        text: 'too early',
      },
    })
    assert.ok(blocked.kind === 'error' && blocked.code === 'CONTROL_UNCERTAIN')
    assert.equal(
      (await host.stats())[0]!.context,
      'original',
    )
    await host.control({
      kind: 'release',
      nativeId: session.nativeId,
    })
    const changed = await next.call({
      id: randomUUID(),
      operation: {
        kind: 'context',
        ref: session.ref,
        controller: grant.control.generation,
        text: 'settled',
      },
    })
    assert.equal(
      changed.kind,
      'ok',
    )
    assert.equal(
      (await host.stats())[0]!.context,
      'settled',
    )
    assert.deepEqual(
      (await host.stats())[0]!.settings,
      ['effort=hold'],
    )
    assert.deepEqual(
      await next.result({ requestId: 'slow-set' }),
      held,
    )
  },
)

test(
  'a late native open remains owned and visible after timeout instead of allowing a duplicate open',
  async t => {
    const host = await fixtureHost({
      t,
      slowControls: true,
    })
    const client = await host.connect()
    const controller = await client.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: { kind: 'host' },
        expectedRevision: 0,
      },
    })
    assert.ok(controller.kind === 'attached')
    const id = randomUUID()
    const options = {
      provider: 'codex' as const,
      cwd: host.root,
      settings: { fixtureOpen: 'hold' },
      environment: {},
    }
    const delayed = await client.call({
      id,
      operation: {
        kind: 'open',
        controller: controller.control.generation,
        options,
      },
    })
    assert.ok(delayed.kind === 'error' && delayed.code === 'OPEN_UNKNOWN')
    const unknown = await host.connect()
    const descriptor = unknown.ready.sessions[0]!
    assert.equal(
      descriptor.phase,
      'recovery_required',
    )
    const native = (await host.stats())[0]!
    await host.control({
      kind: 'release',
      nativeId: native.id,
    })
    await until({
      check: async () => {
        const baseline = await snapshot({
          client: unknown,
          ref: descriptor.ref,
        })

        return baseline.snapshot.session.nativeId === native.id
      },
    })
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    const noDuplicate = await client.call({
      id: randomUUID(),
      operation: {
        kind: 'open',
        controller: controller.control.generation,
        options: {
          ...options,
          settings: {},
        },
      },
    })
    assert.ok(noDuplicate.kind === 'error' && noDuplicate.code === 'RECOVERY_REQUIRED')
    assert.equal(
      (await host.stats()).length,
      1,
    )
    assert.deepEqual(
      await unknown.result({ requestId: id }),
      delayed,
    )
    const claim = await unknown.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: descriptor.ref,
        },
        expectedRevision: 0,
      },
    })
    assert.ok(claim.kind === 'attached')
    const close = await unknown.call({
      id: randomUUID(),
      operation: {
        kind: 'close',
        ref: descriptor.ref,
        controller: claim.control.generation,
        expectedIdle: true,
      },
    })
    assert.equal(
      close.kind,
      'ok',
    )
    assert.equal(
      (await host.stats())[0]!.closed,
      true,
    )
  },
)

test(
  'the host refuses wrong installation, token, protocol and capabilities before creating any native agent',
  async t => {
    const host = await fixtureHost({ t })
    const token = readFileSync(
      join(
        host.root,
        'token',
      ),
      'utf8',
    )
    await assert.rejects(
      connectHost({
        socket: host.socket,
        installation: 'wrong',
        token,
      }),
      /AUTH_FAILED/,
    )
    await assert.rejects(
      connectHost({
        socket: host.socket,
        installation: 'fixture-installation',
        token: 'wrong',
      }),
      /AUTH_FAILED/,
    )
    await assert.rejects(
      connectHost({
        socket: host.socket,
        installation: 'fixture-installation',
        token,
        capabilities: ['unsupported-feature'],
      }),
      /CAPABILITY_MISMATCH/,
    )
    const response = deferred<ToClient>()
    const socket = createConnection(host.socket)
    t.after(() => socket.destroy())
    socket.setEncoding('utf8')
    socket.once(
      'connect',
      () => socket.write(`${JSON.stringify({
        type: 'hello',
        protocol: 99,
        token,
        installation: 'fixture-installation',
      })}\n`),
    )
    socket.once(
      'data',
      value => response.resolve(JSON.parse(String(value).trim())),
    )
    socket.once(
      'error',
      error => response.reject(error),
    )
    const timeout = setTimeout(
      () => response.reject(new Error('Handshake response missing')),
      WAIT_MS,
    )

    try {
      const frame = await response.promise
      assert.ok(frame.type === 'error' && frame.code === 'PROTOCOL_MISMATCH')
    } finally {
      clearTimeout(timeout)
    }

    const valid = await host.connect()
    assert.equal(
      valid.ready.ledger,
      'intact',
    )
    assert.deepEqual(
      await host.stats(),
      [],
    )
  },
)

test(
  'startup refuses an unrelated live socket without unlinking it',
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-host-live-'))
    const path = join(
      root,
      'host.sock',
    )
    const server = createServer(socket => socket.end('still alive'))
    t.after(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await new Promise<void>(resolve => server.listen(
      path,
      resolve,
    ))
    await assert.rejects(
      fixtureHost({
        t,
        directory: root,
      }),
      /SOCKET_IN_USE/,
    )
    const socket = createConnection(path)
    const received = deferred<string>()
    const timeout = setTimeout(
      () => received.reject(new Error('Unrelated socket was lost')),
      WAIT_MS,
    )
    socket.setEncoding('utf8')
    socket.once(
      'data',
      value => received.resolve(String(value)),
    )
    socket.once(
      'error',
      error => received.reject(error),
    )

    try {
      assert.equal(
        await received.promise,
        'still alive',
      )
    } finally {
      clearTimeout(timeout); socket.destroy()
    }
  },
)

test(
  'a synchronous native burst cannot overflow the host fact sink',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    client.detach()
    await host.control({
      kind: 'burst',
      nativeId: session.nativeId,
      count: 1100,
    })
    const next = await host.connect()
    const replay = await snapshot({
      client: next,
      ref: session.ref,
    })
    assert.ok(replay.pendingFacts.some(fact => fact.event.type === 'structured' && JSON.stringify(fact.event.value) === '{"afterBurst":true}'))
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
  },
)

test(
  'socket pressure disconnects a slow observer while the native owner and critical output survive',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    const baseline = deferred<void>()
    const closed = deferred<void>()
    const socket = createConnection(host.socket)
    t.after(() => socket.destroy())
    socket.setEncoding('utf8')
    let buffered = '', watching = false
    socket.once(
      'connect',
      () => socket.write(`${JSON.stringify({
        type: 'hello',
        protocol: 1,
        installation: 'fixture-installation',
        token: readFileSync(
          join(
            host.root,
            'token',
          ),
          'utf8',
        ),
      })}\n`),
    )
    socket.on(
      'data',
      chunk => {
        buffered += chunk
        let newline = buffered.indexOf('\n')

        while (newline >= 0) {
          const frame: ToClient = JSON.parse(buffered.slice(
            0,
            newline,
          ))
          buffered = buffered.slice(newline + 1)

          if (frame.type === 'ready') {
            socket.write(`${JSON.stringify({
              type: 'watch',
              ref: session.ref,
            })}\n`)
          } else if (frame.type === 'snapshot') {
            watching = true
            socket.pause()
            baseline.resolve()
          }

          newline = buffered.indexOf('\n')
        }
      },
    )
    socket.on(
      'error',
      error => {
        // Backpressure can reset an authenticated peer; the close event confirms disconnection.
        if (!watching) {
          baseline.reject(error)
        }
      },
    )
    socket.once(
      'close',
      () => closed.resolve(),
    )
    const attachmentTimeout = setTimeout(
      () => baseline.reject(new Error('Slow observer did not attach')),
      WAIT_MS,
    )
    t.after(() => clearTimeout(attachmentTimeout))
    await baseline.promise
    clearTimeout(attachmentTimeout)
    const disconnectTimeout = setTimeout(
      () => closed.reject(new Error('Slow observer was not disconnected')),
      WAIT_MS,
    )
    t.after(() => clearTimeout(disconnectTimeout))

    const burst = async () => {
      await host.control({
        kind: 'burst',
        nativeId: session.nativeId,
        count: PRESSURE_EVENT_COUNT,
        textBytes: PRESSURE_FRAME_BYTES,
      })
      socket.resume()
    }

    await Promise.all([
      burst(),
      closed.promise,
    ])
    clearTimeout(disconnectTimeout)
    assert.equal(
      (await host.stats())[0]!.closed,
      false,
    )
    const next = await host.connect()
    const replay = await snapshot({
      client: next,
      ref: session.ref,
    })
    assert.ok(replay.pendingFacts.some(fact => fact.event.type === 'structured' && JSON.stringify(fact.event.value) === '{"afterBurst":true}'))
  },
)

test(
  'a snapshot that exceeds the frame limit fails explicitly instead of returning truncated critical facts',
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
        type: 'structured',
        value: 'x'.repeat(MAX_FRAME_BYTES),
      },
    })
    const response = deferred<ToClient>()
    const unsubscribe = client.subscribe({
      receive: ({ frame }) => {
        if (frame.type === 'error' || frame.type === 'snapshot' && frame.ref.id === session.ref.id) {
          response.resolve(frame)
        }
      },
    })
    const timeout = setTimeout(
      () => response.reject(new Error('Oversized snapshot was not refused')),
      WAIT_MS,
    )

    try {
      client.watch({ ref: session.ref })
      const frame = await response.promise
      assert.ok(frame.type === 'error' && frame.code === 'OUTPUT_TOO_LARGE')
      const next = await host.connect()
      assert.equal(
        next.ready.sessions[0]?.phase,
        'recovery_required',
      )
    } finally {
      clearTimeout(timeout)
      unsubscribe()
    }
  },
)

test(
  'hard retention pressure retains the triggering fact and fails the native session explicitly',
  async t => {
    const host = await fixtureHost({
      t,
      pressure: true,
    })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    const payload = 'x'.repeat(17000)
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'structured',
        value: payload,
      },
    })
    await until({ check: async () => (await host.stats())[0]?.closed === true })
    const baseline = await snapshot({
      client,
      ref: session.ref,
    })
    const fact = baseline.pendingFacts.find(fact => fact.event.type === 'structured')
    assert.ok(fact?.event.type === 'structured')
    assert.equal(
      fact.event.value,
      payload,
    )
    assert.equal(
      baseline.snapshot.retention,
      'exhausted',
    )
    assert.equal(
      baseline.snapshot.session.phase,
      'recovery_required',
    )
    assert.ok(baseline.pendingFacts.some(fact => fact.event.type === 'ended' && fact.event.reason === 'failed'))
    assert.equal(
      (await client.call({
        id: randomUUID(),
        operation: {
          kind: 'input',
          ref: session.ref,
          controller: session.token,
          input: {
            id: 'after-exhaustion',
            text: 'Refuse',
            images: [],
          },
        },
      })).kind,
      'error',
    )
  },
)

test(
  'an ambiguous answer has a live value-free unknown receipt until native submission arrives',
  async t => {
    const host = await fixtureHost({
      t,
      slowControls: true,
    })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    const asked = host.control({
      kind: 'ask',
      nativeId: session.nativeId,
      expected: 'secret',
      submit: false,
    })
    await until({
      check: async () => (await snapshot({
        client,
        ref: session.ref,
      })).pendingFacts.some(fact => fact.event.type === 'permission'),
    })
    const answerId = randomUUID()
    const requestId = randomUUID()
    const result = await client.call({
      id: requestId,
      operation: {
        kind: 'answer',
        ref: session.ref,
        controller: session.token,
        answerId,
        permission: 'native-ask',
        decision: {
          behavior: 'allow',
          values: { password: 'secret' },
        },
      },
    })
    await asked
    assert.deepEqual(
      result,
      {
        kind: 'answer',
        receipt: {
          answerId,
          permission: 'native-ask',
          phase: 'unknown',
        },
      },
    )
    const baseline = await snapshot({
      client,
      ref: session.ref,
    })
    assert.ok(baseline.pendingFacts.some(fact => fact.event.type === 'answer' && fact.event.receipt.answerId === answerId && fact.event.receipt.phase === 'unknown'))
    assert.equal(
      readFileSync(
        join(
          host.root,
          'sessions',
          session.ref.id,
          'outbox.jsonl',
        ),
        'utf8',
      ).includes('secret'),
      false,
    )
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'answer-submitted',
        id: 'native-ask',
      },
    })
    assert.deepEqual(
      await client.result({ requestId }),
      {
        kind: 'answer',
        receipt: {
          answerId,
          permission: 'native-ask',
          phase: 'submitted',
        },
      },
    )
    assert.equal(
      (await host.stats())[0]!.answers,
      1,
    )
  },
)

test(
  'an interrupt cannot target a turn that has already been replaced',
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
        type: 'turn-started',
        turn: 'new-turn',
      },
    })
    const stale = await client.call({
      id: randomUUID(),
      operation: {
        kind: 'interrupt',
        ref: session.ref,
        controller: session.token,
        expectedTurn: 'old-turn',
      },
    })
    assert.ok(stale.kind === 'error' && stale.code === 'STALE_TURN')
    assert.equal(
      (await host.stats())[0]!.interrupts,
      0,
    )
    assert.equal(
      (await client.call({
        id: randomUUID(),
        operation: {
          kind: 'interrupt',
          ref: session.ref,
          controller: session.token,
          expectedTurn: 'new-turn',
        },
      })).kind,
      'ok',
    )
    assert.equal(
      (await host.stats())[0]!.interrupts,
      1,
    )
  },
)

test(
  'transport preserves durable completion before the following live turn',
  async t => {
    const host = await fixtureHost({ t })
    const client = await host.connect()
    const session = await controlledSession({
      host,
      client,
    })
    await snapshot({
      client,
      ref: session.ref,
    })
    const frames: Extract<ToClient, { type: 'event' }>[] = []
    client.subscribe({
      receive: ({ frame }) => {
        if (frame.type === 'event' && frame.ref.id === session.ref.id) {
          frames.push(frame)
        }
      },
    })
    await host.control({
      kind: 'event',
      nativeId: session.nativeId,
      event: {
        type: 'result',
        turn: 'first-turn',
        inputIds: [],
        status: 'completed',
        queued: 0,
      },
      nextEvent: 'working',
    })
    await until({ check: () => frames.some(frame => frame.event === 'working') })
    const turnEvents = frames.filter(frame => frame.event === 'working'
      || typeof frame.event === 'object' && frame.event.type === 'turn-ended')
    assert.deepEqual(
      turnEvents.map(frame => typeof frame.event === 'string' ? frame.event : frame.event.type),
      [
        'turn-ended',
        'working',
      ],
    )
    assert.ok(turnEvents[0]!.seq < turnEvents[1]!.seq)
  },
)
