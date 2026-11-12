import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeDispatch } from '#test-harness/dispatch-fixture.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { openPage } from '#test-harness/harness.ts'
import { settle } from '#test-harness/child-fixture.ts'
import { decidePush } from '#tasks/push.ts'
import { commands } from './cli.ts'
import { withWriter } from './writer.ts'
import { startServer } from './server-daemon.ts'

test(
  'changed shared-login limits reach clients of both Hydras, including agentId sessions',
  async t => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-shared-usage-',
    )))
    const previous = process.env.PNYX_HOME
    const previousPath = process.env.PATH
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    let server: Awaited<ReturnType<typeof startServer>> | undefined = undefined
    const pages: { close(): void }[] = []
    t.after(async () => {
      try {
        for (const page of pages) {
          page.close()
        }

        await server?.close()
      } finally {
        if (previous === undefined) {
          delete process.env.PNYX_HOME
        } else {
          process.env.PNYX_HOME = previous
        }

        process.env.PATH = previousPath
        rmSync(
          root,
          {
            recursive: true,
            force: true,
          },
        )
      }
    })
    const login = fakeDispatch({ root }).claude
    const quota = join(
      login,
      'quota.json',
    )
    writeFileSync(
      quota,
      JSON.stringify({
        provider: {
          plan: 'Shared plan',
          windows: [
            {
              label: 'Daily',
              percentUsed: 10,
            },
          ],
        },
      }),
    )
    const cards = new Map<string, string>()

    for (const hydraId of [
      'one',
      'two',
    ]) {
      await commands.hydra([
        'create',
        hydraId,
      ])
      const id = withWriter({
        hydraId,
        fn: ({ writer }) => {
          const decision = decidePush({
            state: writer.state,
            key: 'quota',
            input: {
              activity: 'finished',
              agent: {
                provider: 'claude-code',
                sessionId: hydraId,
                agentId: 'child',
                account: 'claude:test',
                loginFolder: login,
              },
            },
            meta: {
              actor: 'fixture',
              at: new Date().toISOString(),
            },
          })
          assert.ok('event' in decision)
          writer.append({ event: decision.event })

          return decision.event.cardId
        },
      })
      cards.set(
        hydraId,
        id,
      )
    }

    const running = await startServer({
      hydraId: 'one',
      port: 0,
      homes: [],
      query: claudeNative().query,
    })
    server = running
    const first = await openPage({
      port: running.port,
      hydraId: 'one',
    })
    pages.push(first)
    const second = await openPage({
      port: running.port,
      hydraId: 'two',
    })
    pages.push(second)
    const one = cards.get('one')!
    const two = cards.get('two')!
    await first.command({
      name: 'hydra',
      args: [
        'usage',
        'refresh',
        '--task',
        one,
        '--force',
      ],
    })
    await second.command({
      name: 'hydra',
      args: [
        'usage',
        'refresh',
        '--task',
        two,
      ],
    })
    await settle({
      what: 'initial limits on both clients',
      check: () =>
        first.usages[one]?.windows[0]?.used === 10 && second.usages[two]?.windows[0]?.used === 10,
    })
    writeFileSync(
      quota,
      JSON.stringify({
        provider: {
          plan: 'Shared plan',
          windows: [
            {
              label: 'Daily',
              percentUsed: 40,
            },
          ],
        },
      }),
    )
    await first.command({
      name: 'hydra',
      args: [
        'usage',
        'refresh',
        '--task',
        one,
        '--force',
      ],
    })
    await settle({
      what: 'changed limits delivered to both Hydras without refreshing the second',
      check: () =>
        first.usages[one]?.windows[0]?.used === 40 && second.usages[two]?.windows[0]?.used === 40,
    })
  },
)
