import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { serviceFile } from '#setup/service.ts'

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
async function isolated({
  t,
  extra = {},
}: {
  t: TestContext
  // More environment for the CLI and the servers it starts.
  extra?: NodeJS.ProcessEnv
}) {
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
    ...extra,
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

test(
  'a command with the server down starts it through the installed login service',
  async t => {
    const fakes = join(
      import.meta.dirname,
      'fixtures',
      'service',
    )
    const calls = join(
      realpathSync(mkdtempSync('/tmp/pnyx-service-')),
      'calls',
    )
    const {
      root,
      run,
      serverPath,
    } = await isolated({
      t,
      extra: {
        PATH: `${fakes}:${process.env.PATH}`,
        FAKE_SERVICE_LOG: calls,
        PNYX_TEST_NODE: process.execPath,
        PNYX_TEST_CLI: cli,
      },
    })
    // The service file this home's CLI looks for, at the path it computes from its own home.
    const saved = process.env.PNYX_HOME
    process.env.PNYX_HOME = root
    const service = serviceFile({
      userHome: root,
      configHome: process.env.XDG_CONFIG_HOME,
    })
    process.env.PNYX_HOME = saved
    mkdirSync(
      dirname(service.path),
      { recursive: true },
    )
    writeFileSync(
      service.path,
      '',
    )

    const listed = await run({
      args: [
        'task',
        'list',
      ],
    })
    assert.match(
      listed.stdout,
      /tasks/,
    )
    assert.ok(existsSync(serverPath))
    assert.match(
      readFileSync(
        calls,
        'utf8',
      ),
      process.platform === 'linux' ? /systemctl --user start local\.pnyx\.server\./ : /launchctl bootstrap gui\/\d+ /,
    )
  },
)

test(
  'a torn log that stops the server is repaired from the CLI, and the server starts with every accepted change',
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
    await run({
      args: [
        'task',
        'create',
        '--title',
        'Kept through a torn log',
        '--key',
        'torn',
      ],
    })
    await run({ args: ['stop'] })
    await until({
      check: () => !existsSync(serverPath),
      timeout: START_TIMEOUT_MS,
    })
    const dir = join(
      root,
      'hydras',
      'default',
    )
    // A crash mid-append leaves part of a line at the end of the log.
    appendFileSync(
      join(
        dir,
        'events.jsonl',
      ),
      '{"v":1,"seq":',
    )

    const repaired = await run({ args: ['repair'] })
    assert.match(
      repaired.stdout,
      /torn/i,
    )
    assert.deepEqual(
      readdirSync(dir).filter(name => name.startsWith('events.jsonl.torn-'))
        .map(name => readFileSync(
          join(
            dir,
            name,
          ),
          'utf8',
        )),
      ['{"v":1,"seq":'],
    )
    await run({ args: ['restart'] })
    await until({
      check: () => existsSync(serverPath),
      timeout: START_TIMEOUT_MS,
    })
    assert.match(
      (await run({
        args: [
          'task',
          'show',
          'torn',
        ],
      })).stdout,
      /Kept through a torn log/,
    )
  },
)
