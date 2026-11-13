import assert from 'node:assert/strict'
import { readUsage } from './dispatch.ts'
import { settle } from '#test-harness/child-fixture.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { withWriter } from '#app/writer.ts'
import { decidePush } from '#tasks/push.ts'
import { fakeDispatch } from '#test-harness/dispatch-fixture.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { writeDocument } from './dispatch-config.ts'
import type { DispatchDocument } from './dispatch-check.ts'

test(
  'catalogs and usage read the selected home, including after the account registration changes',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-account-catalog-',
    ))
    const previous = process.env.PNYX_HOME
    const previousPath = process.env.PATH
    process.env.PNYX_HOME = root
    t.after(() => {
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
    })
    await commands.hydra([
      'create',
      'lab',
    ])
    fakeDispatch({ root })
    const homes = {
      personal: join(
        root,
        'personal',
      ),
      work: join(
        root,
        'work',
      ),
    }
    const document: DispatchDocument = {
      accounts: {
        personal: {
          provider: 'claude',
          folder: homes.personal,
        },
        work: {
          provider: 'claude',
          folder: homes.work,
        },
      },
      main: 'personal',
      default: [{ harness: 'claude' }],
      workers: { claude: ['personal'] },
      projects: {},
      rules: {},
    }
    writeDocument({ document })
    const reads: string[] = []
    const streamed: string[] = []
    let usageChanges = 0
    const fixture = claudeNative()
    const host = createHost({
      hydraId: 'lab',
      query: ({
        prompt,
        options,
      }) => {
        assert.equal(
          options?.persistSession,
          false,
        )
        assert.equal(
          options?.strictMcpConfig,
          true,
        )
        assert.deepEqual(
          options?.mcpServers,
          {},
        )
        const folder = options?.env?.CLAUDE_CONFIG_DIR
        assert.ok(folder)
        reads.push(folder)
        const catalog = fixture.query({
          prompt,
          options,
        })
        catalog.supportedModels = async () => [
          {
            value: folder === homes.work ? 'work-model' : 'personal-model',
            displayName: folder,
            description: 'Synthetic account model',
          },
        ]

        return catalog
      },
      changed: () => {},
      streamed: ({ session }) => {
        streamed.push(session)
      },
      usageChanged: () => {
        usageChanges++
      },
    })
    t.after(() => host.close())
    const [
      work,
      personal,
    ] = await Promise.all([
      host.models({
        harness: 'claude',
        account: 'work',
      }),
      host.models({
        harness: 'claude',
        account: 'personal',
      }),
    ])
    assert.equal(
      work[0]?.value,
      'work-model',
    )
    assert.equal(
      personal[0]?.value,
      'personal-model',
    )
    assert.deepEqual(
      new Set(reads),
      new Set(Object.values(homes)),
    )
    await host.models({
      harness: 'claude',
      account: 'work',
    })
    assert.equal(
      reads.length,
      2,
    )

    for (const [
      name,
      folder,
    ] of Object.entries(homes)) {
      mkdirSync(
        folder,
        { recursive: true },
      )
      writeFileSync(
        join(
          folder,
          'quota.json',
        ),
        JSON.stringify({ provider: { plan: name } }),
      )
    }

    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          key: 'usage-fixture',
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'selected-work',
              account: 'work',
              loginFolder: homes.work,
            },
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    await commands.hydra([
      'set',
      '--session',
      'claude-code:selected-work',
      '--hydra',
      'lab',
    ])
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          key: 'usage-sibling',
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'shared-work',
              account: 'work',
              loginFolder: homes.work,
            },
          },
          meta: {
            actor: 'fixture',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const quotaCommand = join(
      root,
      'fake-bin',
      'quota-axi',
    )
    const quotaFixture = join(
      root,
      'fake-bin',
      'quota-fixture',
    )
    const quotaReads = join(
      root,
      'quota-reads.jsonl',
    )
    const quotaGate = join(
      root,
      'quota-gate',
    )
    const quotaReady = join(
      root,
      'quota-ready',
    )
    const quotaRelease = join(
      root,
      'quota-release',
    )
    renameSync(
      quotaCommand,
      quotaFixture,
    )
    writeFileSync(
      quotaCommand,
      `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
appendFileSync(${JSON.stringify(quotaReads)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const readFixture = () => {
  const result = spawnSync(process.execPath, [${JSON.stringify(quotaFixture)}, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
};
if (existsSync(${JSON.stringify(quotaGate)})) {
  const fail = readFileSync(${JSON.stringify(quotaGate)}, 'utf8') === 'fail';
  unlinkSync(${JSON.stringify(quotaGate)});
  writeFileSync(${JSON.stringify(quotaReady)}, '');
  const gateTimeoutMs = 5000;
  const gatePollMs = 10;
  const until = Date.now() + gateTimeoutMs;
  setInterval(() => {
    if (existsSync(${JSON.stringify(quotaRelease)})) {
      if (fail) process.exit(1);
      readFixture();
    }
    if (Date.now() >= until) process.exit(1);
  }, gatePollMs);
} else {
  readFixture();
}
`,
      { mode: 0o755 },
    )
    streamed.length = 0
    await Promise.all([
      host.refreshUsage({}),
      host.refreshUsage({}),
      host.refreshUsage({}),
    ])
    assert.equal(
      usageChanges,
      1,
      'a new plan rebuilds the Hydra\'s usage once, not once per session',
    )
    assert.deepEqual(
      streamed,
      [],
    )
    assert.equal(
      readFileSync(
        quotaReads,
        'utf8',
      ).trim()
        .split('\n').length,
      1,
    )
    usageChanges = 0
    await host.refreshUsage({})
    assert.equal(
      usageChanges,
      0,
    )
    const usage = await host.usage()
    assert.ok('who' in usage)
    assert.equal(
      usage.who.account,
      'work',
    )
    assert.equal(
      usage.who.plan,
      'work',
    )
    await host.refreshUsage({ force: true })
    assert.equal(
      usageChanges,
      0,
      'identical forced quota contents rebuild nothing',
    )
    const maxAges = readFileSync(
      quotaReads,
      'utf8',
    ).trim()
      .split('\n')
      .map(line => {
        const args: string[] = JSON.parse(line)

        return args[args.indexOf('--max-age') + 1]
      })
    assert.deepEqual(
      maxAges,
      [
        '0',
        '0',
      ],
    )
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.now(),
    })
    t.mock.timers.tick(5 * 60_000)
    await host.refreshUsage({})
    assert.equal(
      readFileSync(
        quotaReads,
        'utf8',
      ).trim()
        .split('\n').length,
      3,
    )
    assert.equal(
      usageChanges,
      0,
      'identical expired quota contents rebuild nothing',
    )
    t.mock.timers.reset()
    writeFileSync(
      join(
        homes.work,
        'quota.json',
      ),
      JSON.stringify({
        provider: {
          plan: 'work',
          windows: [
            {
              label: 'Daily',
              percentUsed: 10,
            },
          ],
        },
      }),
    )
    await host.refreshUsage({ force: true })
    assert.equal(
      usageChanges,
      1,
      'changed window contents rebuild every session\'s usage',
    )
    writeDocument({
      document: {
        ...document,
        accounts: {
          ...document.accounts,
          work: {
            provider: 'claude',
            folder: homes.personal,
          },
        },
      },
    })
    const repointed = await host.models({
      harness: 'claude',
      account: 'work',
    })
    assert.equal(
      repointed[0]?.value,
      'personal-model',
    )
    await host.refreshUsage({})
    const afterEdit = await host.usage()
    assert.ok('who' in afterEdit)
    assert.equal(
      afterEdit.who.plan,
      'work',
    )
    const quotaPath = join(
      homes.work,
      'quota.json',
    )
    const savedQuota = readFileSync(
      quotaPath,
      'utf8',
    )
    rmSync(join(
      homes.work,
      'quota.json',
    ))
    await host.refreshUsage({ force: true })
    const unavailable = await host.usage()
    assert.ok('who' in unavailable)
    assert.equal(
      unavailable.who.plan,
      undefined,
    )
    writeFileSync(
      quotaPath,
      'malformed quota fixture',
    )
    await host.refreshUsage({ force: true })
    writeFileSync(
      quotaPath,
      savedQuota,
    )
    await host.refreshUsage({})
    const retried = await host.usage()
    assert.ok('who' in retried)
    assert.equal(
      retried.who.plan,
      'work',
      'a failed quota reading does not suppress the next refresh',
    )
    writeFileSync(
      quotaReads,
      '',
    )
    writeFileSync(
      quotaGate,
      'fail',
    )
    const account = {
      provider: 'claude' as const,
      folder: homes.work,
    }
    const older = readUsage({
      account,
      refresh: true,
    })

    try {
      await settle({
        what: 'older quota request before failure',
        check: () => existsSync(quotaReady),
      })
      const newer = await readUsage({
        account,
        refresh: true,
      })
      assert.equal(
        newer?.plan,
        'work',
      )
    } finally {
      writeFileSync(
        quotaRelease,
        '',
      )
      assert.equal(
        await older,
        undefined,
      )
    }

    assert.equal(
      (await readUsage({ account }))?.plan,
      'work',
    )
    assert.equal(
      readFileSync(
        quotaReads,
        'utf8',
      ).trim()
        .split('\n').length,
      2,
      'an older failed reading cannot evict the newer forced result',
    )
    await assert.rejects(
      host.models({
        harness: 'codex',
        account: 'work',
      }),
      /not registered for codex/,
    )
    await assert.rejects(
      host.models({
        harness: 'claude',
        account: 'missing',
      }),
      /not registered/,
    )
    assert.equal(
      reads.length,
      2,
    )
  },
)
