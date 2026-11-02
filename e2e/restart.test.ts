import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { processStart } from '#agent-host/discovery.ts'
import { until } from '#agent-host/fixtures/harness.ts'

const START_TIMEOUT_MS = 30000
const cli = join(
  import.meta.dirname,
  '../dist/cli/pnyx-axi.js',
)

test(
  'restart starts a stopped app and rotates an idle native host on the same build',
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-restart-'))
    const socket = createServer()
    socket.listen(
      0,
      '127.0.0.1',
    )
    await new Promise<void>(resolve => socket.once(
      'listening',
      resolve,
    ))
    const address = socket.address()
    assert.ok(address && typeof address === 'object')
    const port = address.port
    await new Promise<void>(resolve => socket.close(() => resolve()))
    const env = {
      ...process.env,
      PNYX_HOME: root,
      HOME: root,
      PORT: String(port),
    }
    const serverPath = join(
      root,
      'hydras/default/server.json',
    )
    const ownerPath = join(
      root,
      'native/owner.json',
    )
    const run = async ({
      args,
      actor = 'cli',
    }: {
      args: string[]
      actor?: string
    }) => promisify(execFile)(
      process.execPath,
      [
        cli,
        ...args,
      ],
      {
        env: {
          ...env,
          PNYX_ACTOR: actor,
        },
      },
    )
    t.after(async () => {
      if (existsSync(serverPath)) {
        const saved = JSON.parse(readFileSync(
          serverPath,
          'utf8',
        ))
        process.kill(
          saved.pid,
          'SIGTERM',
        )
        await until({
          check: () => !existsSync(serverPath),
          timeout: START_TIMEOUT_MS,
        })
      }

      if (existsSync(ownerPath)) {
        const owner = JSON.parse(readFileSync(
          ownerPath,
          'utf8',
        ))

        if (processStart({ pid: owner.pid }) === owner.start) {
          process.kill(
            owner.pid,
            'SIGTERM',
          )
        }

        await until({ check: () => !existsSync(ownerPath) })
      }

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await assert.rejects(
      run({
        args: ['restart'],
        actor: 'worker:fixture',
      }),
      (error: Error & { stdout?: string }) => {
        assert.match(
          error.stdout ?? '',
          /Only the owner/,
        )

        return true
      },
    )
    const firstStart = await run({ args: ['restart'] })
    assert.match(
      firstStart.stdout,
      /starting/,
    )
    await until({
      check: () => existsSync(serverPath),
      timeout: START_TIMEOUT_MS,
    })
    const first = JSON.parse(readFileSync(
      serverPath,
      'utf8',
    ))
    const owner = JSON.parse(readFileSync(
      ownerPath,
      'utf8',
    ))
    const initialHealth = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    const restarted = await run({ args: ['restart'] })
    assert.match(
      restarted.stdout,
      /restarting/,
    )
    let restartedInstance = ''
    await until({
      timeout: START_TIMEOUT_MS,
      check: () => existsSync(serverPath) && JSON.parse(readFileSync(
        serverPath,
        'utf8',
      )).pid !== first.pid,
    })
    const health = await fetch(`http://127.0.0.1:${port}/hydra/default/health`)
    assert.equal(
      health.status,
      200,
    )
    await until({
      timeout: START_TIMEOUT_MS,
      check: async () => {
        const response = await fetch(`http://127.0.0.1:${port}/health`)
        const health = await response.json()

        restartedInstance = health.native?.instance

        return restartedInstance !== initialHealth.native.instance && health.native.state === 'ready'
      },
    }).catch(async error => {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      t.diagnostic(`owner: ${readFileSync(
        ownerPath,
        'utf8',
      )} health: ${await response.text()}`)
      t.diagnostic(readFileSync(
        join(
          root,
          'service.log',
        ),
        'utf8',
      ))
      throw error
    })
    const currentOwner = JSON.parse(readFileSync(
      ownerPath,
      'utf8',
    ))
    assert.notEqual(
      currentOwner.pid,
      owner.pid,
    )
    process.kill(
      currentOwner.pid,
      'SIGKILL',
    )
    await until({
      timeout: START_TIMEOUT_MS,
      check: async () => {
        const response = await fetch(`http://127.0.0.1:${port}/health`)
        const health = await response.json()

        return health.native?.instance !== restartedInstance && health.native.state === 'ready'
      },
    })
  },
)
