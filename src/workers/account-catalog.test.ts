import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
    renameSync(
      quotaCommand,
      quotaFixture,
    )
    writeFileSync(
      quotaCommand,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
appendFileSync(${JSON.stringify(quotaReads)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const result = spawnSync(process.execPath, [${JSON.stringify(quotaFixture)}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      { mode: 0o755 },
    )
    await Promise.all([
      host.refreshUsage({}),
      host.refreshUsage({}),
      host.refreshUsage({}),
    ])
    assert.equal(
      readFileSync(
        quotaReads,
        'utf8',
      ).trim()
        .split('\n').length,
      1,
    )
    await host.refreshUsage({})
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
        '5m',
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
    t.mock.timers.reset()
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
