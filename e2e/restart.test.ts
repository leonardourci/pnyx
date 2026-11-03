import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const START_TIMEOUT_MS = 30000

async function until({
  check,
  timeout = 5000,
}: {
  check(): boolean
  timeout?: number
}) {
  for (const end = Date.now() + timeout; !check();) {
    if (Date.now() > end) {
      throw new Error('condition not met in time')
    }

    await delay(50)
  }
}

const cli = join(
  import.meta.dirname,
  '../dist/cli/pnyx-axi.js',
)

// A Pnyx home and port of its own, the CLI run against them, and a server stopped when the test ends.
async function isolated({ t }: { t: TestContext }) {
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
    'server.json',
  )

  const run = async ({
    args,
    actor = 'cli',
    input = '',
    cwd,
  }: {
    args: string[]
    actor?: string
    input?: string
    cwd?: string
  }) => {
    const running = promisify(execFile)(
      process.execPath,
      [
        cli,
        ...args,
      ],
      {
        cwd,
        env: {
          ...env,
          PNYX_ACTOR: actor,
        },
      },
    )
    running.child.stdin?.end(input)

    return running.catch(error => {
      const log = join(
        root,
        'service.log',
      )

      if (existsSync(log)) {
        t.diagnostic(readFileSync(
          log,
          'utf8',
        ))
      }

      throw error
    })
  }

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

    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  })

  return {
    root,
    run,
    serverPath,
    port,
  }
}

test(
  'restart starts a stopped app and replaces a running one on the same build',
  async t => {
    const {
      run,
      serverPath,
      port,
    } = await isolated({ t })
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
    const restarted = await run({ args: ['restart'] })
    assert.match(
      restarted.stdout,
      /restarting/,
    )
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
  },
)

test(
  'a command with no server running and no login service installed says so and starts nothing',
  async t => {
    const {
      run,
      serverPath,
    } = await isolated({ t })
    await assert.rejects(
      run({
        args: [
          'task',
          'list',
        ],
      }),
      (error: Error & { stdout?: string }) => {
        assert.match(
          error.stdout ?? '',
          /code: NOT_RUNNING/,
        )

        return true
      },
    )
    const context = await run({ args: ['context'] })
    assert.equal(
      context.stdout,
      '',
    )
    assert.equal(
      existsSync(serverPath),
      false,
    )
  },
)

test(
  'the CLI runs each kind of command line in the server: output, stdin, home, context and owner-only refusals',
  async t => {
    const {
      root,
      run,
      serverPath,
    } = await isolated({ t })
    await run({ args: ['restart'] })
    await until({
      check: () => existsSync(serverPath),
      timeout: START_TIMEOUT_MS,
    })
    const shop = join(
      root,
      'shop',
    )
    mkdirSync(shop)
    await run({
      args: [
        'project',
        'add',
        shop,
      ],
    })
    const created = await run({
      args: [
        'task',
        'create',
        '--title',
        'Fix the cart total',
        '--project',
        'shop',
      ],
    })
    const id = /id: (task-[\w-]+)/.exec(created.stdout)?.[1]
    assert.ok(id)
    assert.match(
      (await run({
        args: [
          'task',
          'list',
        ],
      })).stdout,
      /Fix the cart total/,
    )
    await assert.rejects(
      run({
        args: [
          'apply',
          '--file',
          '-',
        ],
        input: '{"version":999,"version":1,"changes":[{"op":"task.brief","op":"task.create","title":"First","ti\\u0074le":"Second","key":"json-dupe"}],"changes":[{"op":"task.create","title":"Other","key":"other"}]}',
      }),
      (error: Error & {
        code?: number
        stdout?: string
      }) => {
        assert.equal(
          error.code,
          2,
        )
        assert.match(
          error.stdout ?? '',
          /errors\[4\]/,
        )

        return true
      },
    )
    assert.match(
      (await run({ args: [] })).stdout,
      new RegExp(`task show ${id}`),
    )
    const context = await run({
      args: [
        'context',
        '--cwd',
        shop,
      ],
    })
    assert.match(
      context.stdout,
      /Fix the cart total,queued/,
    )
    await assert.rejects(
      run({
        args: [
          'task',
          'hold',
          id,
          '--reason',
          'Worker hold',
        ],
        actor: 'worker:fixture',
      }),
      (error: Error & { stdout?: string }) => {
        assert.match(
          error.stdout ?? '',
          /code: OWNER_ONLY/,
        )

        return true
      },
    )
  },
)

test(
  'a relative project path is the caller\'s folder, not the server\'s',
  async t => {
    const {
      root,
      run,
      serverPath,
    } = await isolated({ t })
    await run({ args: ['restart'] })
    await until({
      check: () => existsSync(serverPath),
      timeout: START_TIMEOUT_MS,
    })
    const caller = join(
      root,
      'caller',
    )
    mkdirSync(caller)
    await run({
      args: [
        'project',
        'add',
        '.',
      ],
      cwd: caller,
    })
    const listed = await run({
      args: [
        'project',
        'list',
      ],
    })
    assert.match(
      listed.stdout,
      new RegExp(`${caller}\\b`),
    )
  },
)
