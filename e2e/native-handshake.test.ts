import assert from 'node:assert/strict'
import { execFile, fork, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { processStart } from '#agent-host/discovery.ts'
import { serviceFile } from '#setup/service.ts'
import { until } from '#agent-host/fixtures/harness.ts'

const TIMEOUT_MS = 40000
const cli = join(
  import.meta.dirname,
  '../dist/cli/pnyx-axi.js',
)
type Owner = {
  pid: number
  start: string
}

function readOptional<T>({ path }: { path: string }): T | undefined {
  try {
    return JSON.parse(readFileSync(
      path,
      'utf8',
    )) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined
    }

    throw error
  }
}

async function stopOwned({
  pid,
  start,
}: Owner) {
  if (processStart({ pid }) !== start) {
    return
  }

  try {
    process.kill(
      pid,
      'SIGTERM',
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return
    }

    throw error
  }

  try {
    await until({
      timeout: 1500,
      check: () => processStart({ pid }) !== start,
    })
  } catch {
    if (processStart({ pid }) === start) {
      process.kill(
        pid,
        'SIGKILL',
      )
    }

    await until({
      timeout: 5000,
      check: () => processStart({ pid }) !== start,
    })
  }
}

async function fixture({
  t,
  stallRestart = false,
  managed = false,
  holdTurn = false,
}: {
  t: TestContext
  stallRestart?: boolean
  managed?: boolean
  holdTurn?: boolean
}) {
  const root = realpathSync(mkdtempSync('/tmp/pnyx-handshake-'))
  const listener = createServer()
  listener.listen(
    0,
    '127.0.0.1',
  )
  await once(
    listener,
    'listening',
  )
  const address = listener.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  const bin = join(
    root,
    'bin',
  )
  mkdirSync(bin)
  const fake = join(
    import.meta.dirname,
    '../src/test-harness/fakes/codex-app-server.ts',
  )
  writeFileSync(
    join(
      bin,
      'codex',
    ),
    `#!/bin/sh\nexec '${process.execPath}' --conditions=source '${fake}' "$@"\n`,
    { mode: 0o755 },
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PNYX_HOME: root,
    HOME: root,
    CODEX_HOME: join(
      root,
      'codex',
    ),
    CLAUDE_CONFIG_DIR: join(
      root,
      'claude',
    ),
    XDG_CONFIG_HOME: join(
      root,
      'config',
    ),
    PATH: `${bin}:/usr/bin:/bin`,
    PORT: String(port),
    PNYX_ACTOR: 'cli',
  }

  if (managed) {
    env.PNYX_SERVICE_ROLE = 'application'
  }

  if (holdTurn) {
    env.FAKE_CODEX_RELEASE_FILE = join(
      root,
      'release-turn',
    )
  }

  if (stallRestart) {
    env.PNYX_TEST_STALL_RESTART = '1'
    env.NODE_OPTIONS = `--import=${join(
      import.meta.dirname,
      '../src/test-harness/fakes/stall-restart.mjs',
    )}`
  }

  const serverPath = join(
    root,
    'hydras/default/server.json',
  )
  const ownerPath = join(
    root,
    'native/owner.json',
  )
  const pid = () => readOptional<{ pid: number }>({ path: serverPath })?.pid
  const owner = () => readOptional<Owner>({ path: ownerPath })
  const owned: {
    host?: Owner
    direct?: ChildProcess
  } = {}
  const run = async ({
    args,
    extraEnv,
    timeout = TIMEOUT_MS,
  }: {
    args: string[]
    extraEnv?: NodeJS.ProcessEnv
    timeout?: number
  }) => promisify(execFile)(
    process.execPath,
    [
      cli,
      ...args,
    ],
    {
      env: {
        ...env,
        ...extraEnv,
      },
      timeout,
    },
  )
  const health = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { native: { state: string } }
  t.after(async () => {
    if (owned.direct && owned.direct.exitCode === null && owned.direct.signalCode === null) {
      const exited = once(
        owned.direct,
        'exit',
      )
      owned.direct.kill('SIGKILL')
      await exited
    }

    const server = pid()

    if (server !== undefined) {
      const start = processStart({ pid: server })

      if (start) {
        await stopOwned({
          pid: server,
          start,
        })
      }
    }

    if (owned.host) {
      await stopOwned(owned.host)
    }

    const current = owner()

    if (current && processStart({ pid: current.pid }) === current.start) {
      await stopOwned(current)
    }

    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  })
  await run({ args: ['restart'] })
  const log = join(
    root,
    'service.log',
  )
  await until({
    timeout: TIMEOUT_MS,
    check: () => pid() !== undefined && !!owner() && existsSync(log)
    && readFileSync(
      log,
      'utf8',
    ).includes('server: running'),
  })
  const host = owner()
  assert.ok(host)
  assert.equal(
    processStart({ pid: host.pid }),
    host.start,
  )
  owned.host = host

  return {
    root,
    port,
    env,
    serverPath,
    ownerPath,
    pid,
    owner,
    host,
    owned,
    run,
    health,
  }
}

for (const failure of [
  'silent',
  'rejected',
] as const) {
  for (const route of [
    'startup',
    'cli',
    'composer',
  ] as const) {
    test(
      `${route} recovers a ${failure} native handshake`,
      async t => {
        const app = await fixture({ t })
        const before = app.pid()
        assert.ok(before)

        if (route === 'startup') {
          process.kill(
            before,
            'SIGTERM',
          )
          await until({
            timeout: TIMEOUT_MS,
            check: () => app.pid() === undefined,
          })
        }

        if (failure === 'silent') {
          process.kill(
            app.host.pid,
            'SIGSTOP',
          )
        } else {
          writeFileSync(
            join(
              app.root,
              'native/token',
            ),
            'rejected-fixture-token',
          )
        }

        if (route === 'startup') {
          app.owned.direct = spawn(
            process.execPath,
            [
              cli,
              'serve',
              '--port',
              String(app.port),
            ],
            {
              env: app.env,
              stdio: 'ignore',
            },
          )
        } else if (route === 'composer') {
          await app.run({
            args: [
              'hydra',
              'send',
              '--text',
              '/restart',
            ],
          })
        } else {
          await app.run({ args: ['restart'] })
        }

        await until({
          timeout: TIMEOUT_MS,
          check: () => {
            const current = app.pid()

            return current !== undefined && current !== before
          },
        })
        await until({
          timeout: TIMEOUT_MS,
          check: async () => {
            try {
              return (await app.health()).native.state === 'ready'
            } catch {
              return false
            }
          },
        })
        assert.notEqual(
          app.owner()?.pid,
          app.host.pid,
        )
      },
    )
  }
}

test(
  'an unverifiable silent owner is left alive while the app stays available',
  async t => {
    const app = await fixture({ t })
    const before = app.pid()
    const original = readFileSync(
      app.ownerPath,
      'utf8',
    )
    process.kill(
      app.host.pid,
      'SIGSTOP',
    )
    writeFileSync(
      app.ownerPath,
      JSON.stringify({
        ...JSON.parse(original),
        start: 'unverifiable fixture',
      }),
    )
    await app.run({ args: ['restart'] })
    await until({
      timeout: TIMEOUT_MS,
      check: () => {
        const current = app.pid()

        return current !== undefined && current !== before
      },
    })
    assert.equal(
      (await app.health()).native.state,
      'unavailable',
    )
    assert.equal(
      processStart({ pid: app.host.pid }),
      app.host.start,
    )
    writeFileSync(
      app.ownerPath,
      original,
    )
    process.kill(
      app.host.pid,
      'SIGCONT',
    )
    await until({
      timeout: TIMEOUT_MS,
      check: async () => {
        try {
          return (await app.health()).native.state === 'ready'
        } catch {
          return false
        }
      },
    })
    assert.equal(
      app.owner()?.pid,
      app.host.pid,
    )
  },
)

test(
  'a real host recovers a synthetic Codex session after a silent handshake',
  async t => {
    const app = await fixture({ t })
    const statePath = join(
      app.root,
      'hydras/default/snapshot.json',
    )
    const eventsPath = join(
      app.root,
      'hydras/default/events.jsonl',
    )
    await app.run({
      args: [
        'hydra',
        'set',
        '--helper',
        'off',
      ],
    })
    await app.run({
      args: [
        'rule',
        'set',
        'hydra',
        '--harness',
        'codex',
        '--model',
        'fixture',
      ],
    })
    await app.run({
      args: [
        'hydra',
        'send',
        '--text',
        'First synthetic turn',
      ],
    })
    await until({
      timeout: TIMEOUT_MS,
      check: () => {
        const state = JSON.parse(readFileSync(
          statePath,
          'utf8',
        )).state

        return !!state.cards.$hydra?.agent?.sessionId && state.cards.$hydra.sessionActivity === 'finished'
      },
    })
    const original = JSON.parse(readFileSync(
      statePath,
      'utf8',
    )).state.cards.$hydra.agent.sessionId as string
    const finished = () => readFileSync(
      eventsPath,
      'utf8',
    ).split('\n')
      .filter(line => {
        if (!line) {
          return false
        }

        const event = JSON.parse(line)

        return event.type === 'card.pushed' && event.data.agent?.sessionId === original && event.data.activity === 'finished'
      }).length
    const firstFinishes = finished()
    assert.ok(firstFinishes > 0)
    const before = app.pid()
    process.kill(
      app.host.pid,
      'SIGSTOP',
    )
    await app.run({ args: ['restart'] })
    await until({
      timeout: TIMEOUT_MS,
      check: () => {
        const current = app.pid()

        return current !== undefined && current !== before
      },
    })
    await until({
      timeout: TIMEOUT_MS,
      check: async () => {
        try {
          return (await app.health()).native.state === 'ready'
        } catch {
          return false
        }
      },
    })
    await app.run({
      args: [
        'hydra',
        'send',
        '--text',
        'Second synthetic turn',
      ],
    })
    await until({
      timeout: TIMEOUT_MS,
      check: () => finished() > firstFinishes,
    })
    assert.equal(
      JSON.parse(readFileSync(
        statePath,
        'utf8',
      )).state.cards.$hydra.agent.sessionId,
      original,
    )
  },
)

test(
  'restart replaces a frozen application and confirms the replacement is available',
  async t => {
    const app = await fixture({ t })
    const before = app.pid()
    assert.ok(before)
    process.kill(
      before,
      'SIGSTOP',
    )
    const result = await app.run({ args: ['restart'] })
    assert.match(
      result.stdout,
      /restart/,
    )
    await until({
      timeout: TIMEOUT_MS,
      check: () => {
        const current = app.pid()

        return current !== undefined && current !== before
      },
    })
    assert.equal(
      (await app.health()).native.state,
      'ready',
    )
  },
)

async function stallHost({
  app,
  t,
  operation,
}: {
  app: Awaited<ReturnType<typeof fixture>>
  t: TestContext
  operation: 'claim' | 'status'
}) {
  const socket = join(
    app.root,
    'native/host.sock',
  )
  const upstream = join(
    app.root,
    'native/real.sock',
  )
  renameSync(
    socket,
    upstream,
  )
  const proxy = fork(
    join(
      import.meta.dirname,
      '../src/test-harness/fakes/native-stall-proxy.ts',
    ),
    [
      socket,
      upstream,
      app.ownerPath,
      operation,
    ],
    {
      execArgv: ['--conditions=source'],
      stdio: [
        'ignore',
        'ignore',
        'ignore',
        'ipc',
      ],
    },
  )
  t.after(async () => {
    if (proxy.exitCode === null && proxy.signalCode === null) {
      const exited = once(
        proxy,
        'exit',
      )
      proxy.kill('SIGTERM')
      await exited
    }
  })
  await once(
    proxy,
    'message',
  )
}

for (const operation of [
  'claim',
  'status',
] as const) {
  test(
    `restart recovers a host that stalls its ${operation} response`,
    async t => {
      const app = await fixture({ t })
      await stallHost({
        app,
        t,
        operation,
      })
      const before = app.pid()
      await app.run({ args: ['restart'] })
      await until({
        timeout: TIMEOUT_MS,
        check: () => {
          const current = app.pid()

          return current !== undefined && current !== before
        },
      })
      await until({
        timeout: TIMEOUT_MS,
        check: async () => {
          try {
            return (await app.health()).native.state === 'ready' && app.owner()?.pid !== app.host.pid
          } catch {
            return false
          }
        },
      })
    },
  )
}

test(
  'composer restart replaces an application whose shutdown hangs',
  async t => {
    const app = await fixture({
      t,
      stallRestart: true,
    })
    const before = app.pid()
    assert.ok(before)
    await app.run({
      args: [
        'hydra',
        'send',
        '--text',
        '/restart',
      ],
    })
    await until({
      timeout: TIMEOUT_MS,
      check: () => {
        const current = app.pid()

        return current !== undefined && current !== before
      },
    })
    assert.equal(
      (await app.health()).native.state,
      'ready',
    )
  },
)

test(
  'restart leaves an application with an unverifiable identity untouched',
  async t => {
    const app = await fixture({ t })
    const before = app.pid()
    assert.ok(before)
    const start = processStart({ pid: before })
    assert.ok(start)
    const lock = join(
      app.root,
      'hydras/default/server.lock',
    )
    const original = readFileSync(
      lock,
      'utf8',
    )
    process.kill(
      before,
      'SIGSTOP',
    )
    writeFileSync(
      lock,
      JSON.stringify({
        ...JSON.parse(original),
        processStart: 'unverifiable fixture',
      }),
    )
    await assert.rejects(
      app.run({ args: ['restart'] }),
      (error: Error & { stdout?: string }) => {
        assert.match(
          error.stdout ?? '',
          /identity is not verifiable/,
        )

        return true
      },
    )
    assert.equal(
      processStart({ pid: before }),
      start,
    )
    writeFileSync(
      lock,
      original,
    )
    process.kill(
      before,
      'SIGCONT',
    )
  },
)

test(
  'composer restart failure releases later messages',
  async t => {
    const app = await fixture({ t })
    await app.run({
      args: [
        'hydra',
        'set',
        '--helper',
        'off',
      ],
    })
    await app.run({
      args: [
        'rule',
        'set',
        'hydra',
        '--harness',
        'codex',
        '--model',
        'fixture',
      ],
    })
    const lock = join(
      app.root,
      'hydras/default/server.lock',
    )
    const snapshot = join(
      app.root,
      'hydras/default/snapshot.json',
    )
    const original = readFileSync(
      lock,
      'utf8',
    )

    try {
      writeFileSync(
        lock,
        JSON.stringify({
          ...JSON.parse(original),
          processStart: 'unverifiable fixture',
        }),
      )
      await app.run({
        args: [
          'hydra',
          'send',
          '--text',
          '/restart',
        ],
      })
      await app.run({
        args: [
          'hydra',
          'send',
          '--text',
          'message after failed restart',
        ],
      })
      await until({
        timeout: 12000,
        check: () => {
          const state = JSON.parse(readFileSync(
            snapshot,
            'utf8',
          )).state
          const operation = state.upgrades?.find((item: { state: string }) => item.state === 'failed')

          return operation?.error?.includes('identity is not verifiable') && !operation.held?.length
            && state.cards.$hydra?.sessionActivity === 'finished'
        },
      })
    } finally {
      writeFileSync(
        lock,
        original,
      )
    }
  },
)

test(
  'explicit restart replaces a responsive host holding a stuck turn',
  async t => {
    const app = await fixture({
      t,
      holdTurn: true,
    })
    await app.run({
      args: [
        'hydra',
        'set',
        '--helper',
        'off',
      ],
    })
    await app.run({
      args: [
        'rule',
        'set',
        'hydra',
        '--harness',
        'codex',
        '--model',
        'fixture',
      ],
    })
    await app.run({
      args: [
        'hydra',
        'send',
        '--text',
        'Hold this turn',
      ],
    })
    const statePath = join(
      app.root,
      'hydras/default/snapshot.json',
    )
    let latest = ''
    await until({
      timeout: TIMEOUT_MS,
      check: async () => {
        const state = JSON.parse(readFileSync(
          statePath,
          'utf8',
        )).state
        const status = await app.run({
          args: [
            'native',
            'status',
          ],
        })
        latest = `${state.cards.$hydra?.sessionActivity}: ${status.stdout}`

        return state.cards.$hydra?.sessionActivity === 'working'
          && status.stdout.includes('Native turns, inputs, tools, queue or background work are active or unknown')
      },
    }).catch(error => {
      t.diagnostic(latest)
      throw error
    })
    const activeOwner = app.owner()
    assert.ok(activeOwner)
    const sessionId = JSON.parse(readFileSync(
      statePath,
      'utf8',
    )).state.cards.$hydra.agent.sessionId
    await app.run({
      args: ['restart'],
      extraEnv: { PNYX_RESTART_SAFE: '1' },
    })
    const safeDeadline = Date.now() + 6500
    await until({
      timeout: 10000,
      check: async () => {
        assert.equal(
          app.owner()?.pid,
          activeOwner.pid,
        )
        const status = await app.run({
          args: [
            'native',
            'status',
          ],
        })
        assert.match(
          status.stdout,
          /Native turns, inputs, tools, queue or background work are active or unknown/,
        )

        return Date.now() >= safeDeadline
      },
    })
    await app.run({ args: ['restart'] })
    await until({
      timeout: 15000,
      check: () => !!app.owner() && app.owner()?.pid !== activeOwner.pid,
    })
    writeFileSync(
      join(
        app.root,
        'release-turn',
      ),
      '',
    )
    const events = join(
      app.root,
      'hydras/default/events.jsonl',
    )
    const finishes = () => readFileSync(
      events,
      'utf8',
    ).split('\n')
      .filter(line => {
        if (!line) {
          return false
        }

        const event = JSON.parse(line)

        return event.type === 'card.pushed' && event.data.agent?.sessionId === sessionId && event.data.activity === 'finished'
      }).length
    const beforeFinishes = finishes()
    await app.run({
      args: [
        'hydra',
        'send',
        '--text',
        'Continue after recovery',
      ],
    })
    await until({
      timeout: TIMEOUT_MS,
      check: () => {
        const card = JSON.parse(readFileSync(
          statePath,
          'utf8',
        )).state.cards.$hydra

        return card?.agent?.sessionId === sessionId && card.sessionActivity === 'finished' && finishes() > beforeFinishes
      },
    })
  },
)

test(
  'restart retains the selected Hydra and watched home',
  async t => {
    const app = await fixture({ t })
    const home = join(
      app.root,
      'firstmate-fixture',
    )
    mkdirSync(
      join(
        home,
        'state',
      ),
      { recursive: true },
    )
    await app.run({
      args: [
        'hydra',
        'create',
        'other',
      ],
    })
    await app.run({ args: ['stop'] })
    const direct = spawn(
      process.execPath,
      [
        cli,
        'serve',
        '--hydra',
        'other',
        '--home',
        home,
        '--port',
        String(app.port),
      ],
      {
        env: app.env,
        stdio: 'ignore',
      },
    )
    app.owned.direct = direct
    const other = join(
      app.root,
      'hydras/other/server.json',
    )
    await until({
      timeout: TIMEOUT_MS,
      check: () => existsSync(other),
    })
    await app.run({ args: ['restart'] })
    const response = await fetch(
      `http://127.0.0.1:${app.port}/`,
      { redirect: 'manual' },
    )
    assert.match(
      response.headers.get('location') ?? '',
      /\/hydra\/other\//,
    )
    const log = readFileSync(
      join(
        app.root,
        'service.log',
      ),
      'utf8',
    )
    assert.match(
      log,
      /watching 1 home/,
    )
  },
)

for (const legacy of [
  false,
  true,
]) {
  test(
    `restart waits for ${legacy ? 'a legacy' : 'a'} service-managed application to be replaced`,
    async t => {
      const app = await fixture({
        t,
        managed: true,
      })
      const before = app.pid()
      assert.ok(before)

      if (legacy) {
        const info = JSON.parse(readFileSync(
          app.serverPath,
          'utf8',
        )) as { service?: boolean }
        delete info.service
        writeFileSync(
          app.serverPath,
          JSON.stringify(info),
        )
        const previous = process.env.PNYX_HOME
        let path: string

        try {
          process.env.PNYX_HOME = app.root
          path = serviceFile({
            userHome: app.root,
            configHome: join(
              app.root,
              'config',
            ),
          }).path
        } finally {
          if (previous === undefined) {
            delete process.env.PNYX_HOME
          } else {
            process.env.PNYX_HOME = previous
          }
        }

        mkdirSync(
          dirname(path),
          { recursive: true },
        )
        writeFileSync(
          path,
          'fixture',
        )
      }

      process.kill(
        before,
        'SIGSTOP',
      )
      const restarting = app.run({ args: ['restart'] })
      restarting.catch(() => {})
      await until({
        timeout: TIMEOUT_MS,
        check: () => !processStart({ pid: before }),
      })
      app.owned.direct = spawn(
        process.execPath,
        [
          cli,
          'serve',
          '--port',
          String(app.port),
        ],
        {
          env: app.env,
          stdio: 'ignore',
        },
      )
      const result = await restarting
      assert.match(
        result.stdout,
        /restarting: ready/,
      )
      assert.equal(
        app.pid(),
        app.owned.direct.pid,
      )
      assert.equal(
        (await app.health()).native.state,
        'ready',
      )
    },
  )
}

test(
  'a stalled status with unverifiable ownership remains pending without a signal',
  async t => {
    const app = await fixture({ t })
    await stallHost({
      app,
      t,
      operation: 'status',
    })
    const owner = readFileSync(
      app.ownerPath,
      'utf8',
    )
    writeFileSync(
      app.ownerPath,
      JSON.stringify({
        ...JSON.parse(owner),
        start: 'unverifiable fixture',
      }),
    )
    await app.run({ args: ['restart'] })
    const log = join(
      app.root,
      'service.log',
    )
    await until({
      timeout: TIMEOUT_MS,
      check: async () => {
        try {
          return (await app.health()).native.state === 'unavailable'
        && readFileSync(
          log,
          'utf8',
        ).includes('Native host reconnect failed:')
        } catch {
          return false
        }
      },
    })
    assert.equal(
      processStart({ pid: app.host.pid }),
      app.host.start,
    )
    assert.equal(
      app.owner()?.pid,
      app.host.pid,
    )
  },
)

test(
  'restart waits for a slow but healthy replacement application',
  async t => {
    const app = await fixture({ t })
    const before = app.pid()
    const marker = join(
      app.root,
      'slow-serve.pid',
    )
    const preload = join(
      import.meta.dirname,
      '../src/test-harness/fakes/slow-serve.mjs',
    )
    const pending = app.run({
      args: ['restart'],
      timeout: 150000,
      extraEnv: {
        NODE_OPTIONS: `--import=${preload}`,
        PNYX_TEST_SLOW_SERVE: marker,
      },
    })
    const outcome = (async () => {
      try {
        return { value: await pending }
      } catch (error) {
        return { error }
      }
    })()
    let replacement = 0
    let start: string | undefined

    try {
      await until({
        timeout: TIMEOUT_MS,
        check: () => existsSync(marker),
      })
      replacement = Number(readFileSync(
        marker,
        'utf8',
      ))
      start = processStart({ pid: replacement })
      assert.ok(start)
      await delay(48000)
      assert.equal(
        processStart({ pid: replacement }),
        start,
      )
      process.kill(
        replacement,
        'SIGCONT',
      )
      await until({
        timeout: TIMEOUT_MS,
        check: () => app.pid() === replacement && app.pid() !== before,
      })
      const result = await outcome

      if ('error' in result) {
        const error = result.error
        const detail = error instanceof Error && 'stdout' in error ? String(error.stdout) : String(error)
        assert.fail(`restart failed: ${detail}`)
      }

      assert.equal(
        (await app.health()).native.state,
        'ready',
      )
    } finally {
      if (start && processStart({ pid: replacement }) === start) {
        process.kill(
          replacement,
          'SIGCONT',
        )
      }
    }
  },
)
