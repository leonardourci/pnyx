import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from './cli.ts'
import { hydraDir } from './home-migration.ts'
import { loadHydra } from './store.ts'
import { readEvents } from './event-log.ts'
import { startServer } from './server-daemon.ts'
import { emptyHydra, replay } from './reducer.ts'
import { openPage, until } from '#test-harness/harness.ts'

test(
  'a post-save lock handoff confirms once and reclaims the failed command lease',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-command-handoff-',
    ))
    const saved = { ...process.env }
    const marker = join(
      root,
      'handoff',
    )
    process.env.PNYX_HOME = join(
      root,
      'home',
    )
    process.env.PNYX_SEMANTIC = 'off'
    process.env.PNYX_HANDOFF_MARKER = marker
    process.env.PNYX_LOCK_OWNER = String(process.pid)
    process.env.NODE_OPTIONS = `${saved.NODE_OPTIONS ?? ''} --import ${join(
      import.meta.dirname,
      'fixtures',
      'command-lock.mjs',
    )}`.trim()
    t.after(() => {
      process.env = saved
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    commands.hydra([
      'create',
      'lab',
    ])
    commands.task([
      'create',
      '--title',
      'Original',
      '--key',
      'original',
      '--hydra',
      'lab',
    ])
    const created = loadHydra({ hydraId: 'lab' }).state
    const cardId = created.keys.original!
    const server = await startServer({ hydraId: 'lab' })
    const page = await openPage({
      port: server.port,
      hydraId: 'lab',
    })
    const dir = hydraDir({ hydraId: 'lab' })
    const lock = join(
      dir,
      'writer.lock',
    )

    try {
      const args = [
        'rename',
        cardId,
        '--title',
        'Saved',
        '--event-id',
        'post-save-handoff',
      ]
      const sending = page.command({
        name: 'task',
        args,
      })
      const outcome = (async () => {
        try {
          return { receipt: await sending }
        } catch (error) {
          return { error }
        }
      })()
      await until({
        what: 'the committed write and concurrent lock handoff',
        check: () => existsSync(marker),
      })
      await until({
        what: 'the save waiting for cleanup',
        check: () => page.checking.length > 0,
      })
      const failedPid = Number(readFileSync(
        marker,
        'utf8',
      ))
      assert.throws(
        () => process.kill(
          failedPid,
          0,
        ),
        { code: 'ESRCH' },
      )
      assert.equal(
        loadHydra({ hydraId: 'lab' }).state.cards[cardId]?.title,
        'Saved',
      )
      rmSync(lock)
      const result = await outcome
      assert.ok(
        'receipt' in result,
        JSON.stringify(result),
      )
      await page.command({
        name: 'task',
        args,
      })
      const events = readEvents({ hydraId: 'lab' })
      assert.equal(
        events.filter(event => event.id === 'post-save-handoff').length,
        1,
      )
      assert.deepEqual(
        readdirSync(dir).filter(name => name.startsWith('helper-lease-')),
        [],
      )
      assert.deepEqual(
        loadHydra({ hydraId: 'lab' }).state,
        replay({
          state: emptyHydra(),
          events,
        }),
      )
    } finally {
      rmSync(
        lock,
        { force: true },
      )
      page.close()
      await server.close()
    }
  },
)

test(
  'shutdown waits for an admitted command and refuses later commands',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-command-shutdown-',
    ))
    const saved = { ...process.env }
    const marker = join(
      root,
      'worker',
    )
    const gate = join(
      root,
      'release',
    )
    process.env.PNYX_HOME = join(
      root,
      'home',
    )
    process.env.PNYX_SEMANTIC = 'off'
    process.env.PNYX_HANDOFF_MARKER = marker
    process.env.PNYX_COMMAND_GATE = gate
    process.env.NODE_OPTIONS = `${saved.NODE_OPTIONS ?? ''} --import ${join(
      import.meta.dirname,
      'fixtures',
      'command-lock.mjs',
    )}`.trim()
    t.after(() => {
      process.env = saved
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    commands.hydra([
      'create',
      'lab',
    ])
    commands.task([
      'create',
      '--title',
      'Original',
      '--key',
      'original',
      '--hydra',
      'lab',
    ])
    const cardId = loadHydra({ hydraId: 'lab' }).state.keys.original!
    const server = await startServer({ hydraId: 'lab' })
    const page = await openPage({
      port: server.port,
      hydraId: 'lab',
    })
    const sending = page.command({
      name: 'task',
      args: [
        'rename',
        cardId,
        '--title',
        'Admitted',
        '--event-id',
        'admitted',
      ],
    })
    const outcome = (async () => {
      try {
        return { receipt: await sending }
      } catch (error) {
        return { error }
      }
    })()
    let closing: Promise<void> | undefined

    try {
      await until({
        what: 'the admitted command worker',
        check: () => existsSync(marker),
      })
      const pid = Number(readFileSync(
        marker,
        'utf8',
      ))
      closing = server.close()
      await assert.rejects(
        page.command({
          name: 'task',
          args: [
            'rename',
            cardId,
            '--title',
            'Too late',
            '--event-id',
            'too-late',
          ],
        }),
        /shutting down/,
      )
      writeFileSync(
        gate,
        'release',
      )
      await closing
      await outcome
      assert.throws(
        () => process.kill(
          pid,
          0,
        ),
        { code: 'ESRCH' },
      )
      assert.equal(
        loadHydra({ hydraId: 'lab' }).state.cards[cardId]?.title,
        'Admitted',
      )
      assert.equal(
        readEvents({ hydraId: 'lab' }).some(event => event.id === 'too-late'),
        false,
      )
    } finally {
      writeFileSync(
        gate,
        'release',
      )
      page.close()
      await (closing ?? server.close())
    }
  },
)

test(
  'a completed clone is not repeated when attachment encounters a lock',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-clone-lock-',
    ))
    const saved = { ...process.env }
    const source = join(
      root,
      'source.git',
    )
    const destination = join(
      root,
      'cloned',
    )
    process.env.PNYX_HOME = join(
      root,
      'home',
    )
    process.env.PNYX_SEMANTIC = 'off'
    t.after(() => {
      process.env = saved
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    execFileSync(
      'git',
      [
        'init',
        '--bare',
        source,
      ],
      { stdio: 'ignore' },
    )
    commands.hydra([
      'create',
      'lab',
    ])
    const server = await startServer({ hydraId: 'lab' })
    const page = await openPage({
      port: server.port,
      hydraId: 'lab',
    })
    const lock = join(
      process.env.PNYX_HOME,
      'writer.lock',
    )
    writeFileSync(
      lock,
      String(process.pid),
    )

    try {
      await assert.rejects(
        page.command({
          name: 'project',
          args: [
            'add',
            '--clone',
            source,
            '--into',
            destination,
            '--event-id',
            'clone-once',
          ],
        }),
        /locked/,
      )
      assert.equal(
        existsSync(join(
          destination,
          '.git',
        )),
        true,
      )
      assert.equal(
        page.checking.length,
        0,
      )
      assert.equal(
        readEvents({ hydraId: 'lab' }).some(event => event.id === 'clone-once'),
        false,
      )
    } finally {
      rmSync(
        lock,
        { force: true },
      )
      page.close()
      await server.close()
    }
  },
)
