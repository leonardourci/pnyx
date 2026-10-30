import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { ensureNativeHost, nativePaths } from '#setup/native-host.ts'
import { withWriter } from '#app/writer.ts'
import { startServer } from '#app/server-daemon.ts'
import { infoPath } from '#app/server-state.ts'
import { loadHydra } from '#app/store.ts'
import { EVENT_VERSION } from '#store/events.ts'
import { processStart } from '#agent-host/discovery.ts'
import { until } from '#agent-host/fixtures/harness.ts'

test(
  'production startup activates with saved work markers and keeps the same native host',
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-start-'))
    const before = process.env.PNYX_HOME
    process.env.PNYX_HOME = join(
      root,
      'state',
    )
    const paths = nativePaths()
    const connections: Awaited<ReturnType<typeof ensureNativeHost>>[] = []
    t.after(async () => {
      for (const native of connections) {
        native.detach()
      }

      if (existsSync(join(
        paths.directory,
        'owner.json',
      ))) {
        const owner = JSON.parse(readFileSync(
          join(
            paths.directory,
            'owner.json',
          ),
          'utf8',
        ))

        if (processStart({ pid: owner.pid }) === owner.start) {
          process.kill(
            owner.pid,
            'SIGTERM',
          )
        }

        await until({
          check: () => !existsSync(join(
            paths.directory,
            'owner.json',
          )),
        })
      }

      if (before === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = before
      }

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const source = join(
      import.meta.dirname,
      '..',
    )
    const legacy = join(
      process.env.PNYX_HOME,
      'boards',
      'legacy',
    )
    mkdirSync(
      legacy,
      { recursive: true },
    )
    writeFileSync(
      join(
        legacy,
        'server.lock',
      ),
      JSON.stringify({ pid: process.pid }),
    )
    writeFileSync(
      join(
        legacy,
        'server.json',
      ),
      JSON.stringify({ pid: process.pid }),
    )
    await assert.rejects(
      ensureNativeHost({ source }),
      { code: 'NATIVE_MIGRATION_BUSY' },
    )
    assert.equal(
      existsSync(paths.selected),
      false,
    )
    rmSync(
      legacy,
      { recursive: true },
    )
    const previous = await startServer({ port: 0 })

    try {
      await assert.rejects(
        ensureNativeHost({ source }),
        { code: 'NATIVE_MIGRATION_BUSY' },
      )
      assert.equal(
        existsSync(paths.selected),
        false,
      )
    } finally {
      await previous.close()
    }

    const serverPath = infoPath({ hydraId: 'default' })
    writeFileSync(
      serverPath,
      JSON.stringify({ pid: null }),
    )
    await assert.rejects(
      ensureNativeHost({ source }),
      { code: 'RECOVERY_REQUIRED' },
    )
    assert.equal(
      existsSync(paths.selected),
      false,
    )
    const exitedPid = Number(execFileSync(
      process.execPath,
      [
        '-e',
        'process.stdout.write(String(process.pid))',
      ],
      { encoding: 'utf8' },
    ))
    writeFileSync(
      serverPath,
      JSON.stringify({ pid: exitedPid }),
    )
    withWriter({
      hydraId: 'default',
      create: true,
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: EVENT_VERSION,
            seq: writer.state.seq + 1,
            id: 'interrupted-session',
            at: '2026-10-30T00:00:00.000Z',
            actor: 'pnyx',
            cardId: 'task',
            type: 'card.pushed',
            data: {
              key: 'codex:interrupted',
              title: 'Interrupted worker',
              activity: 'working',
              agent: {
                provider: 'codex',
                sessionId: 'interrupted',
                host: 'pnyx',
              },
            },
          },
        })
        writer.append({
          event: {
            v: EVENT_VERSION,
            seq: writer.state.seq + 1,
            id: 'interrupted-helper',
            at: '2026-10-30T00:00:01.000Z',
            actor: 'pnyx',
            cardId: '$hydra',
            type: 'hydra.helper-started',
            data: {
              id: 'interrupted-helper',
              tasks: ['task'],
              prompt: '',
              seqs: [],
            },
          },
        })
        writer.append({
          event: {
            v: EVENT_VERSION,
            seq: writer.state.seq + 1,
            id: 'upgrade-restarting',
            at: '2026-10-30T00:00:02.000Z',
            actor: 'pnyx',
            cardId: '$hydra',
            type: 'pnyx.upgrade',
            data: {
              id: 'upgrade',
              state: 'restarting',
              folder: source,
              queuedAt: '2026-10-30T00:00:00.000Z',
              steps: [
                {
                  step: 'restart',
                  state: 'running',
                  seconds: 0,
                },
              ],
            },
          },
        })
      },
    })
    const started = performance.now()
    const first = await ensureNativeHost({ source })
    connections.push(first)
    const startupMs = performance.now() - started
    const owned = JSON.parse(readFileSync(
      join(
        paths.directory,
        'owner.json',
      ),
      'utf8',
    ))
    const idleBefore = execFileSync(
      '/bin/ps',
      [
        '-o',
        'time=,rss=',
        '-p',
        String(owned.pid),
      ],
      { encoding: 'utf8' },
    ).trim()
    await delay(1000)
    const idleAfter = execFileSync(
      '/bin/ps',
      [
        '-o',
        'time=,rss=',
        '-p',
        String(owned.pid),
      ],
      { encoding: 'utf8' },
    ).trim()
    t.diagnostic(JSON.stringify({
      startupMs,
      idleBefore,
      idleAfter,
    }))
    const owner = readFileSync(
      join(
        paths.directory,
        'owner.json',
      ),
      'utf8',
    )
    const selected = JSON.parse(readFileSync(
      paths.selected,
      'utf8',
    )).bundle as string
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(join(
          selected,
          'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
        )).href)})`,
      ],
      {
        env: {
          ...process.env,
          HOME: root,
        },
      },
    )
    first.detach()
    const second = await ensureNativeHost({
      source: join(
        root,
        'a-new-app-build-that-is-not-loaded',
      ),
    })
    connections.push(second)
    assert.equal(
      readFileSync(
        join(
          paths.directory,
          'owner.json',
        ),
        'utf8',
      ),
      owner,
    )
    assert.equal(
      second.client.ready.instance,
      first.client.ready.instance,
    )
    assert.equal(
      JSON.parse(readFileSync(
        paths.selected,
        'utf8',
      )).bundle,
      selected,
    )
    process.kill(
      owned.pid,
      'SIGTERM',
    )
    await until({
      check: () => !existsSync(join(
        paths.directory,
        'owner.json',
      )),
    })
    await until({
      check: () => second.client.available()
        && second.client.ready.instance !== first.client.ready.instance,
    })
    assert.equal(
      JSON.parse(readFileSync(
        paths.selected,
        'utf8',
      )).bundle,
      selected,
    )
    assert.match(
      readFileSync(
        paths.log,
        'utf8',
      ),
      /SIGTERM/,
    )
    const replacement = JSON.parse(readFileSync(
      join(
        paths.directory,
        'owner.json',
      ),
      'utf8',
    ))
    const replacementInstance = second.client.ready.instance
    process.kill(
      replacement.pid,
      'SIGKILL',
    )
    await until({
      check: () => second.client.available()
        && second.client.ready.instance !== replacementInstance,
    })
    assert.match(
      readFileSync(
        paths.log,
        'utf8',
      ),
      /signal=SIGKILL/,
    )
    assert.equal(
      JSON.parse(readFileSync(
        paths.selected,
        'utf8',
      )).bundle,
      selected,
    )
    const restarted = await startServer({
      native: second,
      port: 0,
    })

    try {
      const health = await fetch(new URL(
        'health',
        restarted.url,
      ))
      assert.equal(
        health.status,
        200,
      )
      assert.equal(
        loadHydra({ hydraId: 'default' }).state.upgrades?.[0]?.state,
        'done',
      )
    } finally {
      await restarted.close()
    }
  },
)
