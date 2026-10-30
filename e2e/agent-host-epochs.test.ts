import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativeProviders } from '#app/native-provider.ts'
import { fixtureHost, snapshot, until } from '#agent-host/fixtures/harness.ts'

test(
  'closed epochs settle trailing ends and apply an older outcome before new admissions',
  async t => {
    const first = await fixtureHost({ t })
    const options = {
      directory: first.root,
      journal: join(
        first.root,
        'bindings',
      ),
      installation: 'fixture-installation',
    }
    const native = await nativeProviders(options)
    t.after(native.detach)
    const open = {
      cwd: first.root,
      settings: {},
      env: { PNYX_ACTOR: 'task:epochs' },
      signal: new AbortController().signal,
    }
    const original = await native.providers.codex.open(open)
    const agent = {
      provider: 'codex',
      sessionId: original.id,
      cwd: first.root,
      host: 'pnyx' as const,
    }
    await first.control({
      kind: 'event',
      nativeId: original.id,
      event: {
        type: 'result',
        turn: 'retained-turn',
        inputIds: ['retained-input'],
        status: 'completed',
        queued: 0,
      },
    })
    await original.close()
    original.detach?.()
    const second = await native.providers.codex.open({
      ...open,
      agent,
    })
    await second.close()
    second.detach?.()
    const third = await native.providers.codex.open({
      ...open,
      agent,
    })
    await third.close()
    third.detach?.()
    const observer = await first.connect()
    const terminal = await snapshot({
      client: observer,
      ref: observer.ready.sessions.find(session => session.ref.epoch === third.incarnation)!.ref,
    })
    assert.equal(
      terminal.pendingFacts.at(-1)!.event.type,
      'ended',
    )
    observer.detach()
    native.detach()
    first.child.kill('SIGKILL')
    await first.exited
    const replacement = await fixtureHost({
      t,
      directory: first.root,
    })
    const recovered = await nativeProviders(options)
    t.after(recovered.detach)
    assert.equal(
      recovered.providers.codex.canOpen?.(),
      false,
    )
    const replay = await recovered.providers.codex.open({
      ...open,
      agent,
    })
    assert.equal(
      replay.incarnation,
      original.incarnation,
    )
    const outcomes = []

    for await (const event of replay.attach!()) {
      if (typeof event === 'object' && event.type === 'turn-ended') {
        outcomes.push(event.outcome.turn)
      }
    }

    replay.detach?.()
    assert.deepEqual(
      outcomes,
      ['retained-turn'],
    )
    await until({ check: () => recovered.providers.codex.canOpen!() })
    const fresh = await recovered.providers.codex.open({
      ...open,
      agent,
    })
    assert.notEqual(
      fresh.incarnation,
      original.incarnation,
    )
    assert.deepEqual(
      (await replacement.stats()).map(state => state.input),
      [[]],
    )
    await fresh.close()
    fresh.detach?.()
    recovered.detach()
    replacement.child.kill('SIGKILL')
    await replacement.exited
    await fixtureHost({
      t,
      directory: first.root,
    })
    const restarted = await nativeProviders(options)
    t.after(restarted.detach)
    await until({ check: () => restarted.status().state === 'ready' })
    assert.equal(
      restarted.providers.codex.canOpen?.(),
      true,
    )
    assert.equal(
      restarted.client.ready.sessions.every(session => session.phase === 'closed'),
      true,
    )
  },
)
