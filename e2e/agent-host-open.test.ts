import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativeProviders } from '#app/native-provider.ts'
import { fingerprint } from '#agent-host/ledger.ts'
import { fixtureHost } from '#agent-host/fixtures/harness.ts'

const SESSION_LIMIT = 64

for (const ending of [
  'clean',
  'crash',
] as const) {
  const provider = 'codex'
  test(
    `an unresolved open clears after a ${ending} host exit without any session`,
    async t => {
      const first = await fixtureHost({ t })
      const observer = await first.connect()
      const journal = join(
        first.root,
        'bindings',
      )
      mkdirSync(journal)
      const path = join(
        journal,
        `${fingerprint({
          value: {
            provider,
            cwd: first.root,
            actor: '',
          },
        })}.json`,
      )
      const request = randomUUID()
      writeFileSync(
        path,
        JSON.stringify({
          request,
          instance: observer.ready.instance,
        }),
      )
      const saved = readFileSync(
        path,
        'utf8',
      )
      const options = {
        directory: first.root,
        journal,
        installation: 'fixture-installation',
      }
      const open = {
        cwd: first.root,
        env: {},
        settings: {},
        signal: new AbortController().signal,
      }
      const current = await nativeProviders(options)
      t.after(current.detach)
      await assert.rejects(
        current.providers[provider].open(open),
        { code: 'NOT_RECEIVED' },
      )
      assert.equal(
        readFileSync(
          path,
          'utf8',
        ),
        saved,
      )
      assert.deepEqual(
        await first.stats(),
        [],
      )
      current.detach()

      if (ending === 'clean') {
        const controller = await first.connect()
        const claim = await controller.call({
          id: randomUUID(),
          operation: {
            kind: 'attach',
            scope: { kind: 'host' },
            expectedRevision: controller.ready.hostControllerRevision,
          },
        })
        assert.ok(claim.kind === 'attached')
        assert.equal(
          (await controller.call({
            id: randomUUID(),
            operation: {
              kind: 'shutdown',
              controller: claim.control.generation,
              when: 'quiescent',
            },
          })).kind,
          'shutdown',
        )
      } else {
        first.child.kill('SIGKILL')
      }

      await first.exited
      const replacement = await fixtureHost({
        t,
        directory: first.root,
      })
      const native = await nativeProviders(options)
      t.after(native.detach)
      const session = await native.providers[provider].open(open)
      t.after(() => session.detach?.())
      assert.ok(session.id)
      assert.notEqual(
        JSON.parse(readFileSync(
          path,
          'utf8',
        )).request,
        request,
      )
      assert.deepEqual(
        (await replacement.stats()).map(state => state.id),
        [session.id],
      )
    },
  )
}

test(
  'a definite session-limit refusal leaves no uncertain application binding',
  async t => {
    const host = await fixtureHost({ t })
    const journal = join(
      host.root,
      'bindings',
    )
    const native = await nativeProviders({
      directory: host.root,
      journal,
      installation: 'fixture-installation',
    })
    t.after(native.detach)

    for (let index = 0; index < SESSION_LIMIT; index++) {
      const session = await native.providers.codex.open({
        cwd: host.root,
        env: { PNYX_ACTOR: `task:${index}` },
        settings: {},
        signal: new AbortController().signal,
      })
      t.after(() => session.detach?.())
    }

    await assert.rejects(
      native.providers.codex.open({
        cwd: host.root,
        env: { PNYX_ACTOR: 'task:overflow' },
        settings: {},
        signal: new AbortController().signal,
      }),
      { code: 'SESSION_LIMIT' },
    )
    assert.equal(
      readdirSync(journal).length,
      SESSION_LIMIT,
    )
    const path = join(
      journal,
      `${fingerprint({
        value: {
          provider: 'codex',
          cwd: host.root,
          actor: 'task:overflow',
        },
      })}.json`,
    )
    assert.equal(
      existsSync(path),
      false,
    )
  },
)

test(
  'an unresolved open stays fenced while its original host may still own it',
  async t => {
    const host = await fixtureHost({
      t,
      slowControls: true,
    })
    const journal = join(
      host.root,
      'bindings',
    )
    const options = {
      directory: host.root,
      journal,
      installation: 'fixture-installation',
    }
    const original = await nativeProviders(options)
    t.after(original.detach)
    const open = {
      cwd: host.root,
      env: {},
      settings: { fixtureOpen: 'hold' },
      signal: new AbortController().signal,
    }
    await assert.rejects(
      original.providers.codex.open(open),
      { code: 'OPEN_UNKNOWN' },
    )
    original.detach()
    const bindings = readdirSync(journal)
    assert.equal(
      bindings.length,
      1,
    )
    const name = bindings[0]
    assert.ok(name)
    const path = join(
      journal,
      name,
    )
    const before = readFileSync(
      path,
      'utf8',
    )
    const retry = await nativeProviders(options)
    t.after(retry.detach)
    await assert.rejects(
      retry.providers.codex.open(open),
      { code: 'OPEN_UNKNOWN' },
    )
    assert.equal(
      readFileSync(
        path,
        'utf8',
      ),
      before,
    )
    assert.equal(
      (await host.stats()).length,
      1,
    )
    const saved = JSON.parse(before)
    assert.equal(
      'session' in saved,
      false,
    )
    retry.detach()
    host.child.kill('SIGKILL')
    await host.exited
    const replacement = await fixtureHost({
      t,
      directory: host.root,
    })
    const observer = await replacement.connect()
    assert.equal(
      observer.ready.readiness.state,
      'ready',
    )
    assert.equal(
      observer.ready.sessions.length,
      1,
    )
    const recovered = await nativeProviders(options)
    t.after(recovered.detach)
    await assert.rejects(
      recovered.providers.codex.open(open),
      { code: 'RECOVERY_REQUIRED' },
    )
    assert.equal(
      readFileSync(
        path,
        'utf8',
      ),
      before,
    )
    assert.equal(
      (await replacement.stats()).length,
      0,
    )
  },
)
