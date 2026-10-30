import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { processStart } from '#agent-host/discovery.ts'
import type { HostClient } from '#agent-host/client.ts'
import { fixtureHost, controlledSession, until } from '#agent-host/fixtures/harness.ts'

const SECOND_MS = 1000

async function startTree({
  host,
  client,
}: {
  host: Awaited<ReturnType<typeof fixtureHost>>
  client: HostClient
}) {
  const opening = controlledSession({
    host,
    client,
    settings: {
      fixtureTree: '1',
      fixtureOpen: 'hold',
    },
  })
  const path = join(
    host.root,
    'owned-tree.json',
  )
  await until({ check: () => existsSync(path) })
  const tree = JSON.parse(readFileSync(
    path,
    'utf8',
  ))
  const born = Math.max(
    Date.parse(tree.parent.start),
    Date.parse(tree.tool.start),
  )
  await until({ check: () => Date.now() >= born + SECOND_MS })
  await host.control({
    kind: 'release',
    nativeId: (await host.stats())[0]!.id,
  })

  return await opening
}

for (const boot of [
  undefined,
  null,
]) {
  test(
    `same-boot recovery cleans positively identified old members before resume with ${boot === null ? 'unknown' : 'known'} boot identity`,
    async t => {
      const first = await fixtureHost({
        t,
        boot,
      })
      const client = await first.connect()
      const session = await startTree({
        host: first,
        client,
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
        'host_lost',
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

for (const damage of [
  'changed identity',
  'missing cutoff',
]) {
  test(
    `${damage} leaves the old group alone and still resumes the saved native session`,
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
        for (const owned of [
          tree.parent,
          tree.tool,
        ]) {
          if (processStart({ pid: owned.pid }) !== owned.start) {
            continue
          }

          try {
            process.kill(
              owned.pid,
              'SIGKILL',
            )
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              throw error
            }
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

      if (damage === 'changed identity') {
        saved.groups[0].start = 'a different process lifetime'
      } else {
        delete saved.lastAliveAt
      }

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
        'closed',
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
      process.kill(
        tree.parent.pid,
        0,
      )
      process.kill(
        tree.tool.pid,
        0,
      )
    },
  )
}
