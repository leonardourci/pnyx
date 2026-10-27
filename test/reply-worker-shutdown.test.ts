import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { commands } from '../src/cli/commands.ts'
import { enqueueSteering } from '../src/task-inbox/inbox.ts'
import { STEERING_GRACE_MS } from '../src/task-inbox/follow-up.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { startServer } from '../src/server/server.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

test(
  'closing the server waits for the inbox-follow worker and nothing is written afterwards',
  async t => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-worker-shutdown-',
    )))
    const home = join(
      root,
      'home',
    )
    const pidFile = join(
      root,
      'worker.pid',
    )
    const doneFile = join(
      root,
      'worker.done',
    )
    const delay = join(
      root,
      'delay.mjs',
    )
    const saved = {
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      PNYX_HOME: process.env.PNYX_HOME,
      PNYX_SEMANTIC: process.env.PNYX_SEMANTIC,
    }
    const options = saved.NODE_OPTIONS
    process.env.PNYX_HOME = home
    process.env.PNYX_SEMANTIC = 'off'
    // Holds the real worker before its first write, so the server closes while it is still running.
    writeFileSync(
      delay,
      `import { writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
if (process.argv.includes('inbox-follow')) {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
  await setTimeout(1500)
  process.once('exit', () => writeFileSync(${JSON.stringify(doneFile)}, 'done'))
}
`,
    )
    process.env.NODE_OPTIONS = `${options ?? ''} --import ${delay}`.trim()
    t.after(() => {
      for (const [
        key,
        value,
      ] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }

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
      '--key',
      'one',
      '--title',
      'One',
      '--hydra',
      'lab',
    ])
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => enqueueSteering({
        writer,
        ref: loadHydra({ hydraId: 'lab' }).state.keys.one!,
        id: 'steer',
        text: 'Keep going',
        source: 'test',
        meta: {
          at: new Date(Date.now() - STEERING_GRACE_MS * 10).toISOString(),
          actor: 'test',
        },
      }),
    })
    const server = await startServer({
      hydraId: 'lab',
      query: hydraSdk().query,
    })

    for (let waited = 0; !existsSync(pidFile) && waited < 10_000; waited += 50) {
      await sleep(50)
    }

    const pid = Number(readFileSync(
      pidFile,
      'utf8',
    ))
    assert.ok(pid > 0)
    await server.close()
    assert.throws(
      () => process.kill(
        pid,
        0,
      ),
      { code: 'ESRCH' },
    )
    assert.ok(
      existsSync(doneFile),
      'close returned before the worker finished',
    )
    const card = loadHydra({ hydraId: 'lab' }).state.cards[loadHydra({ hydraId: 'lab' }).state.keys.one!]!
    assert.ok(card.steering![0]!.recovery!.length > 0)
  },
)
