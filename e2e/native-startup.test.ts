import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { ensureNativeHost, nativePaths } from '#setup/native-host.ts'
import { processStart } from '#agent-host/discovery.ts'
import { until } from '#agent-host/fixtures/harness.ts'

test(
  'production startup pins native code and SDK dependencies, and a second app keeps the same host',
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-start-'))
    const before = process.env.PNYX_HOME
    process.env.PNYX_HOME = join(
      root,
      'state',
    )
    const paths = nativePaths()
    t.after(async () => {
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
    const started = performance.now()
    const first = await ensureNativeHost({
      source: join(
        import.meta.dirname,
        '..',
      ),
    })
    t.after(first.detach)
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
    t.after(second.detach)
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
  },
)
