import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { processStart } from '#app/server-state.ts'

const WAIT_MS = 120000
const cli = join(
  import.meta.dirname,
  '../dist/cli/pnyx-axi.js',
)

async function until({
  check,
  timeout,
}: {
  check(): boolean | Promise<boolean>
  timeout: number
}) {
  for (const end = Date.now() + timeout; !await check();) {
    if (Date.now() > end) {
      throw new Error('condition not met in time')
    }

    await delay(50)
  }
}

test(
  'fresh setup installs one login service and supports starts, restart and session reuse',
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-first-'))
    const home = join(
      root,
      'home',
    )
    const pnyx = join(
      home,
      '.pnyx',
    )
    const bin = join(
      root,
      'bin',
    )
    const managerLog = join(
      root,
      'manager.log',
    )
    mkdirSync(home)
    mkdirSync(bin)
    const manager = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${managerLog}'\ncase "$*" in *print*|*status*) exit 1;; esac\nexit 0\n`

    for (const name of [
      'launchctl',
      'systemctl',
    ]) {
      writeFileSync(
        join(
          bin,
          name,
        ),
        manager,
        { mode: 0o755 },
      )
    }

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
    const socket = createServer()
    socket.listen(
      0,
      '127.0.0.1',
    )
    await once(
      socket,
      'listening',
    )
    const address = socket.address()
    assert.ok(address && typeof address === 'object')
    const port = address.port
    await new Promise<void>(resolve => socket.close(() => resolve()))
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PNYX_HOME: pnyx,
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
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      PNYX_ACTOR: 'cli',
      PNYX_GH_AXI: 'false',
      PNYX_PASEO_URL: 'ws://127.0.0.1:1/ws',
      TMPDIR: root,
      LANG: 'en_US.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(
        root,
        'gitconfig',
      ),
    }
    const serverPath = join(
      pnyx,
      'server.json',
    )
    const snapshot = join(
      pnyx,
      'hydras/default/snapshot.json',
    )
    const events = join(
      pnyx,
      'hydras/default/events.jsonl',
    )
    const run = async ({ args }: { args: string[] }) => promisify(execFile)(
      process.execPath,
      [
        cli,
        ...args,
      ],
      {
        env,
        timeout: WAIT_MS,
      },
    )
    const processes: ChildProcess[] = []
    const server = () => JSON.parse(readFileSync(
      serverPath,
      'utf8',
    )) as { pid: number }

    const stopPid = async ({
      pid,
      start,
    }: {
      pid: number
      start: string
    }) => {
      if (processStart({ pid }) !== start) {
        return
      }

      process.kill(
        pid,
        'SIGTERM',
      )
      await until({
        timeout: WAIT_MS,
        check: () => processStart({ pid }) !== start,
      })
    }

    t.after(async () => {
      for (const child of processes) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
        }
      }

      if (existsSync(serverPath)) {
        const pid = server().pid
        const start = processStart({ pid })

        if (start) {
          await stopPid({
            pid,
            start,
          })
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
    assert.equal(
      existsSync(pnyx),
      false,
    )
    const customHome = join(
      root,
      'custom-pnyx',
    )
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          cli,
          'setup',
          '--preview',
        ],
        {
          env: {
            ...env,
            PNYX_HOME: customHome,
          },
          timeout: WAIT_MS,
        },
      ),
      (error: Error & { stdout?: string }) => {
        assert.match(
          error.stdout ?? '',
          /CUSTOM_HOME_SETUP/,
        )

        return true
      },
    )
    assert.equal(
      existsSync(customHome),
      false,
    )
    await run({ args: ['setup'] })
    assert.ok(existsSync(managerLog))
    const jobs = process.platform === 'linux' ? join(
      root,
      'config/systemd/user',
    ) : join(
      home,
      'Library/LaunchAgents',
    )
    const files = readdirSync(jobs)
    assert.deepEqual(
      files.filter(name => name.startsWith('local.pnyx.')).length,
      1,
    )
    const serverJob = files.find(name => name.startsWith('local.pnyx.server.'))
    assert.ok(serverJob)
    assert.ok(readFileSync(
      join(
        jobs,
        serverJob,
      ),
      'utf8',
    ).includes('4747'))
    await run({
      args: [
        'setup',
        '--port',
        String(port),
      ],
    })
    assert.ok(readFileSync(
      join(
        jobs,
        serverJob,
      ),
      'utf8',
    ).includes(String(port)))

    const start = async () => {
      const child = spawn(
        process.execPath,
        [
          cli,
          'serve',
          '--port',
          String(port),
        ],
        {
          env,
          stdio: 'ignore',
        },
      )
      processes.push(child)
      await until({
        timeout: WAIT_MS,
        check: () => existsSync(serverPath),
      })
      await until({
        timeout: WAIT_MS,
        check: async () => {
          try {
            const response = await fetch(
              `http://127.0.0.1:${port}/health`,
              { signal: AbortSignal.timeout(1000) },
            )

            return response.ok
          } catch {
            return false
          }
        },
      })
    }

    await start()
    await run({
      args: [
        'hydra',
        'set',
        '--helper',
        'off',
      ],
    })
    await run({
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
    await run({
      args: [
        'hydra',
        'send',
        '--text',
        'First setup turn',
      ],
    })
    await until({
      timeout: WAIT_MS,
      check: () => {
        const card = JSON.parse(readFileSync(
          snapshot,
          'utf8',
        )).state.cards.$hydra

        return !!card?.agent?.sessionId && card.sessionActivity === 'finished'
      },
    })
    const session = JSON.parse(readFileSync(
      snapshot,
      'utf8',
    )).state.cards.$hydra.agent.sessionId as string
    const previousServer = server().pid
    await run({ args: ['restart'] })
    await until({
      timeout: WAIT_MS,
      check: () => {
        try {
          return server().pid !== previousServer
        } catch (error) {
          if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false
          }

          throw error
        }
      },
    })
    const finishes = () => readFileSync(
      events,
      'utf8',
    ).split('\n')
      .filter(line => {
        if (!line) {
          return false
        }

        const event = JSON.parse(line)

        return event.type === 'card.pushed' && event.data.agent?.sessionId === session && event.data.activity === 'finished'
      }).length
    const previousFinishes = finishes()
    await run({
      args: [
        'hydra',
        'send',
        '--text',
        'Second setup turn',
      ],
    })
    await until({
      timeout: WAIT_MS,
      check: () => finishes() > previousFinishes,
    })
    assert.equal(
      JSON.parse(readFileSync(
        snapshot,
        'utf8',
      )).state.cards.$hydra.agent.sessionId,
      session,
    )
    await run({ args: ['stop'] })
    await start()
    const afterRestartFinishes = finishes()
    await run({
      args: [
        'hydra',
        'send',
        '--text',
        'Third setup turn',
      ],
    })
    await until({
      timeout: WAIT_MS,
      check: () => finishes() > afterRestartFinishes,
    })
  },
)
