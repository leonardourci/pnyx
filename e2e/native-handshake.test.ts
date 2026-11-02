import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { processStart } from '#agent-host/discovery.ts'
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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

async function fixture({ t }: { t: TestContext }) {
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
  const env = {
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
    PATH: `${bin}:/usr/bin:/bin`,
    PORT: String(port),
    PNYX_ACTOR: 'cli',
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
  const run = async ({ args }: { args: string[] }) => promisify(execFile)(
    process.execPath,
    [
      cli,
      ...args,
    ],
    {
      env,
      timeout: TIMEOUT_MS,
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
