import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
    const setQuota = ({ used }: { used: number }) => writeFileSync(
      quota,
      JSON.stringify({
        provider: {
          plan: 'Shared plan',
          windows: [
            {
              label: 'Daily',
              percentUsed: used,
            },
          ],
        },
      }),
    )
    const forceRefresh = ({
      page,
      task,
    }: {
      page: Awaited<ReturnType<typeof openPage>>
      task: string
    }) => page.command({
      name: 'hydra',
      args: [
        'usage',
        'refresh',
        '--task',
        task,
        '--force',
      ],
    })
    setQuota({ used: 10 })
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
    // The cards are hidden hook cards, so each page asks for hidden cards to receive their usage.
    const first = await openPage({
      port: running.port,
      hydraId: 'one',
      page: ['--hidden'],
    })
    pages.push(first)
    const second = await openPage({
      port: running.port,
      hydraId: 'two',
      page: ['--hidden'],
    })
    pages.push(second)
    const one = cards.get('one')!
    const two = cards.get('two')!
    await forceRefresh({
      page: first,
      task: one,
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
    setQuota({ used: 40 })
    await forceRefresh({
      page: first,
      task: one,
    })
    await settle({
      what: 'changed limits delivered to both Hydras without refreshing the second',
      check: () =>
        first.usages[one]?.windows[0]?.used === 40 && second.usages[two]?.windows[0]?.used === 40,
    })
    const executable = join(
      root,
      'fake-bin',
      'quota-axi',
    )
    const fixture = join(
      root,
      'fake-bin',
      'quota-fixture',
    )
    const gate = join(
      root,
      'quota-gate',
    )
    const ready = join(
      root,
      'quota-ready',
    )
    const release = join(
      root,
      'quota-release',
    )
    renameSync(
      executable,
      fixture,
    )
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const { existsSync, unlinkSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const gated = existsSync(${JSON.stringify(gate)});
const answer = spawnSync(process.execPath, [${JSON.stringify(fixture)}, ...process.argv.slice(2)], { encoding: 'utf8' });
const publish = () => {
  process.stdout.write(answer.stdout ?? '');
  process.stderr.write(answer.stderr ?? '');
  process.exit(answer.status ?? 1);
};
if (!gated) publish();
unlinkSync(${JSON.stringify(gate)});
writeFileSync(${JSON.stringify(ready)}, '');
const TIMEOUT_MS = 10000;
const POLL_MS = 10;
const until = Date.now() + TIMEOUT_MS;
const waiting = setInterval(() => {
  if (existsSync(${JSON.stringify(release)})) { clearInterval(waiting); publish(); }
  if (Date.now() >= until) process.exit(1);
}, POLL_MS);
`,
      { mode: 0o755 },
    )
    setQuota({ used: 50 })
    writeFileSync(
      gate,
      '',
    )
    const older = forceRefresh({
      page: first,
      task: one,
    })

    try {
      await settle({
        what: 'older forced quota read captured before a newer read',
        check: () => existsSync(ready),
      })
      setQuota({ used: 70 })
      await forceRefresh({
        page: second,
        task: two,
      })
      await settle({
        what: 'newer forced limits reach both Hydras',
        check: () =>
          first.usages[one]?.windows[0]?.used === 70 && second.usages[two]?.windows[0]?.used === 70,
      })
    } finally {
      writeFileSync(
        release,
        '',
      )
      await older
    }

    const current = await first.command({
      name: 'hydra',
      args: [
        'usage',
        '--task',
        one,
      ],
    })
    assert.ok(Array.isArray(current.windows))
    assert.equal(
      current.windows[0]?.used,
      70,
      'the older forced read cannot replace newer shared plan limits',
    )
    await settle({
      what: 'both streamed sessions retain the newer shared limits',
      check: () =>
        first.usages[one]?.windows[0]?.used === 70 && second.usages[two]?.windows[0]?.used === 70,
    })
  },
)
