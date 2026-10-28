import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, cpSync, realpathSync as realpath } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { commands } from '../app/cli.ts'
import { enqueueSteering } from './inbox.ts'
import { STEERING_GRACE_MS } from './inbox-follow-up.ts'
import { loadHydra } from '../app/store.ts'
import { withWriter } from '../app/writer.ts'
import { startServer } from '../app/server-daemon.ts'
import { localToken } from '../app/server-state.ts'
import { decidePush } from '../tasks/push.ts'
import { hydraEvent } from '../core/hydra.ts'

// The hook writes the pid file in one call, so an empty read means the worker has not started yet.
async function heldPid({ pidFile }: { pidFile: string }) {
  for (let waited = 0; waited < 10_000; waited += 50) {
    const pid = existsSync(pidFile) ? Number(readFileSync(
      pidFile,
      'utf8',
    )) : 0

    if (pid > 0) {
      return pid
    }

    await sleep(50)
  }

  throw new Error('the held worker never started')
}

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
    })

    const pid = await heldPid({ pidFile })
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

test(
  'closing the server waits for a page reply worker',
  async t => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-worker-shutdown-',
    )))
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
    process.env.PNYX_HOME = join(
      root,
      'home',
    )
    process.env.PNYX_SEMANTIC = 'off'
    // Holds the page's reply worker before its first write, so the server closes while it is still running.
    writeFileSync(
      delay,
      `import { writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
if (process.argv.includes('reply')) {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
  await setTimeout(1500)
  process.once('exit', () => writeFileSync(${JSON.stringify(doneFile)}, 'done'))
}
`,
    )
    process.env.NODE_OPTIONS = `${saved.NODE_OPTIONS ?? ''} --import ${delay}`.trim()
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
    const nativePath = join(
      root,
      'firstmate-fixture',
    )
    cpSync(
      join(
        import.meta.dirname,
        '../integrations/firstmate/fixtures/firstmate-home',
      ),
      nativePath,
      { recursive: true },
    )
    const nativeHome = realpath(nativePath)
    const meta = {
      actor: 'fixture',
      at: new Date().toISOString(),
    }
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.append({
          event: (hydraEvent({
            state: writer.state,
            meta,
            cardId: 'c1',
            change: {
              type: 'task.created',
              data: {
                key: 'layout',
                title: 'Layout',
                column: 'needs_you',
              },
            },
          }) as { event: Parameters<typeof writer.append>[0]['event'] }).event,
        })
        const pushed = decidePush({
          state: writer.state,
          newCardId: 'c2',
          key: 'layout',
          input: {
            source: {
              adapter: 'firstmate',
              instanceId: nativeHome,
              objectId: 'api-v2',
            },
            agent: {
              provider: 'claude-code',
              sessionId: 'fixture-layout',
            },
          },
          meta,
        })

        if ('event' in pushed) {
          writer.append({ event: pushed.event })
        }
      },
    })
    const server = await startServer({
      hydraId: 'default',
      homes: [nativeHome],
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/default/ws?token=${localToken()}`)
    await once(
      ws,
      'open',
    )
    ws.send(JSON.stringify({
      type: 'command',
      id: 'reply-1',
      name: 'reply',
      args: [
        loadHydra({ hydraId: 'default' }).state.keys.layout!,
        'A held reply',
        'held-reply',
      ],
    }))
    const pid = await heldPid({ pidFile })
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
      'close returned before the page reply worker finished',
    )
  },
)
