import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureHost, controlledSession, until } from '#agent-host/fixtures/harness.ts'

for (const boot of [
  undefined,
  null,
]) {
  test(
    `same-boot recovery ends the recorded group before resume with ${boot === null ? 'unknown' : 'known'} boot identity`,
    async t => {
      const first = await fixtureHost({
        t,
        boot,
      })
      const client = await first.connect()
      const session = await controlledSession({
        host: first,
        client,
        settings: { fixtureTree: '1' },
      })
      await until({
        check: () => existsSync(join(
          first.root,
          'owned-tree.json',
        )),
      })
      const tree = JSON.parse(readFileSync(
        join(
          first.root,
          'owned-tree.json',
        ),
        'utf8',
      ))
      const saved = JSON.parse(readFileSync(
        join(
          first.root,
          'sessions',
          session.ref.id,
          'session.json',
        ),
        'utf8',
      ))
      assert.equal(
        saved.groups[0].id,
        tree.parent.pid,
      )
      t.after(() => {
        try {
          process.kill(
            -tree.parent.pid,
            'SIGKILL',
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error
          }
        }
      })
      first.child.kill('SIGKILL')
      await first.exited
      process.kill(
        tree.parent.pid,
        0,
      )
      process.kill(
        tree.tool.pid,
        0,
      )
      const replacement = await fixtureHost({
        t,
        directory: first.root,
        boot,
      })
      const next = await replacement.connect()
      assert.equal(
        next.ready.sessions[0]!.recovery,
        'group_ended',
      )
      assert.equal(
        next.ready.sessions[0]!.phase,
        'closed',
      )
      await until({
        check: () => {
          try {
            process.kill(
              -tree.parent.pid,
              0,
            )

            return false
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH'
          }
        },
      })
      const claim = await next.call({
        id: randomUUID(),
        operation: {
          kind: 'attach',
          scope: { kind: 'host' },
          expectedRevision: 0,
        },
      })
      assert.ok(claim.kind === 'attached')
      const resumed = await next.call({
        id: randomUUID(),
        operation: {
          kind: 'open',
          controller: claim.control.generation,
          options: {
            ...session.options,
            settings: {},
            resume: { nativeId: session.nativeId },
          },
        },
      })
      assert.ok(resumed.kind === 'opened')
      assert.equal(
        resumed.session.nativeId,
        session.nativeId,
      )
      assert.deepEqual(
        (await replacement.stats()).map(state => state.input),
        [[]],
      )
    },
  )
}

test(
  'a changed process-start identity preserves the group and keeps recovery fenced',
  async t => {
    const first = await fixtureHost({ t })
    const client = await first.connect()
    const session = await controlledSession({
      host: first,
      client,
      settings: { fixtureTree: '1' },
    })
    await until({
      check: () => existsSync(join(
        first.root,
        'owned-tree.json',
      )),
    })
    const tree = JSON.parse(readFileSync(
      join(
        first.root,
        'owned-tree.json',
      ),
      'utf8',
    ))
    t.after(() => {
      try {
        process.kill(
          -tree.parent.pid,
          'SIGKILL',
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error
        }
      }
    })
    first.child.kill('SIGKILL')
    await first.exited
    const path = join(
      first.root,
      'sessions',
      session.ref.id,
      'session.json',
    )
    const saved = JSON.parse(readFileSync(
      path,
      'utf8',
    ))
    saved.groups[0].start = 'a different process lifetime'
    writeFileSync(
      path,
      JSON.stringify(saved),
    )
    const replacement = await fixtureHost({
      t,
      directory: first.root,
    })
    const observer = await replacement.connect()
    assert.equal(
      observer.ready.sessions[0]!.phase,
      'recovery_required',
    )
    process.kill(
      tree.parent.pid,
      0,
    )
    process.kill(
      tree.tool.pid,
      0,
    )
    assert.deepEqual(
      await replacement.stats(),
      [],
    )
  },
)
