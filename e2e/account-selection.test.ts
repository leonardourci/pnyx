import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DispatchDocument } from '#workers/dispatch-check.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'a page-saved candidate account reaches the launched worker, while an unset account keeps the configured order',
  async () => {
    const s = await pnyx.scenario()
    const personal = s.folder({ name: 'personal-home' })
    const work = s.folder({ name: 'work-home' })

    for (const [
      name,
      folder,
    ] of [
        [
          'personal',
          personal,
        ],
        [
          'work',
          work,
        ],
      ]) {
      await s.owner({
        args: [
          'account',
          'set',
          name!,
          '--provider',
          'claude',
          '--folder',
          folder!,
        ],
      })
    }

    await s.owner({
      args: [
        'rule',
        'accounts',
        '--provider',
        'claude',
        '--order',
        'personal',
      ],
    })
    await s.owner({
      args: [
        'rule',
        'set',
        'build',
        '--when',
        'Build the feature',
        '--harness',
        'claude',
        '--account',
        'personal',
        '--model',
        'sonnet',
      ],
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      const before = await page.command({
        name: 'rule',
        args: ['show'],
      })
      assert.equal(
        (before.document as DispatchDocument).rules.build?.candidates[0]?.account,
        'personal',
      )
      const distinct = [
        {
          harness: 'claude',
          account: 'personal',
          model: 'sonnet',
        },
        {
          harness: 'claude',
          account: 'work',
          model: 'sonnet',
        },
      ]
      await page.command({
        name: 'rule',
        args: [
          'apply',
          '--json',
          JSON.stringify({
            version: 1,
            patch: { rules: { build: { candidates: distinct } } },
          }),
        ],
      })
      const withAdded = await page.command({
        name: 'rule',
        args: ['show'],
      })
      assert.deepEqual(
        (withAdded.document as DispatchDocument).rules.build?.candidates,
        distinct,
      )
      const duplicates = [
        distinct[0],
        {
          ...distinct[0],
          model: 'opus',
          effort: 'high',
        },
      ]
      const edited = await page.refusal({
        name: 'rule',
        args: [
          'apply',
          '--json',
          JSON.stringify({
            version: 1,
            patch: { rules: { build: { candidates: duplicates } } },
          }),
        ],
      })
      assert.equal(
        edited.code,
        'VALIDATION_ERROR',
      )
      const unchanged = await page.command({
        name: 'rule',
        args: ['show'],
      })
      assert.deepEqual(
        unchanged.document,
        withAdded.document,
      )
      assert.equal(
        unchanged.revision,
        withAdded.revision,
      )
      await page.command({
        name: 'rule',
        args: [
          'apply',
          '--json',
          JSON.stringify({
            version: 1,
            expected: { revision: withAdded.revision },
            patch: {
              rules: {
                build: {
                  candidates: [
                    {
                      harness: 'claude',
                      account: 'work',
                      model: 'sonnet',
                    },
                  ],
                },
              },
            },
          }),
        ],
      })
      const after = await page.command({
        name: 'rule',
        args: ['show'],
      })
      assert.equal(
        (after.document as DispatchDocument).rules.build?.candidates[0]?.account,
        'work',
      )
      const wrongProvider = await page.refusal({
        name: 'models',
        args: [
          'codex',
          'work',
        ],
      })
      assert.equal(
        wrongProvider.code,
        'NO_ACCOUNTS',
      )
    } finally {
      page.close()
    }

    const selectedFolder = s.folder({ name: 'selected-worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'selected',
        '--title',
        'Use Work',
        '--folder',
        selectedFolder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'selected',
        '--rule',
        'build',
        '--reason',
        'Exercise the selected account',
      ],
    })
    const selected = await s.agent({ cwd: selectedFolder })
    assert.equal(
      selected.env.CLAUDE_CONFIG_DIR,
      work,
    )
    assert.equal(
      s.task({ key: 'selected' }).agent?.account,
      'work',
    )
    assert.equal(
      s.task({ key: 'selected' }).agent?.loginFolder,
      work,
    )
    await until({
      what: 'the selected worker to finish',
      check: () => s.task({ key: 'selected' }).sessionActivity === 'finished',
    })

    await s.owner({
      args: [
        'rule',
        'set',
        'build',
        '--account',
        '',
      ],
    })
    const legacyFolder = s.folder({ name: 'legacy-worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'legacy',
        '--title',
        'Use the existing order',
        '--folder',
        legacyFolder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'legacy',
        '--rule',
        'build',
        '--reason',
        'Exercise the existing account order',
      ],
    })
    const legacy = await s.agent({ cwd: legacyFolder })
    assert.equal(
      legacy.env.CLAUDE_CONFIG_DIR,
      personal,
    )
    assert.equal(
      s.task({ key: 'legacy' }).agent?.account,
      'personal',
    )
    await until({
      what: 'the legacy worker to finish',
      check: () => s.task({ key: 'legacy' }).sessionActivity === 'finished',
    })
  },
)

test(
  'task start --account runs the worker on that account’s home, and a candidate whose model that home does not offer is refused before any start',
  async () => {
    const s = await pnyx.scenario()
    const work = s.folder({ name: 'chosen-work-home' })
    await s.owner({
      args: [
        'account',
        'set',
        'work',
        '--provider',
        'claude',
        '--folder',
        work,
      ],
    })
    const chosenFolder = s.folder({ name: 'chosen-worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'chosen',
        '--title',
        'Run on Work',
        '--folder',
        chosenFolder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'chosen',
        '--account',
        'work',
        '--reason',
        'Exercise the chosen account',
      ],
    })
    const chosen = await s.agent({ cwd: chosenFolder })
    assert.equal(
      chosen.env.CLAUDE_CONFIG_DIR,
      work,
    )
    assert.equal(
      s.task({ key: 'chosen' }).agent?.account,
      'work',
    )
    await until({
      what: 'the chosen worker to finish',
      check: () => s.task({ key: 'chosen' }).sessionActivity === 'finished',
    })

    await s.owner({
      args: [
        'rule',
        'set',
        'unoffered',
        '--when',
        'Use a model Work does not offer',
        '--harness',
        'claude',
        '--account',
        'work',
        '--model',
        'claude-unoffered-1',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'unoffered',
        '--title',
        'Use an unoffered model',
        '--folder',
        s.folder({ name: 'unoffered-worker' }),
      ],
    })
    const refused = await s.ownerRefusal({
      args: [
        'task',
        'start',
        'unoffered',
        '--rule',
        'unoffered',
        '--reason',
        'Exercise an unoffered model',
      ],
    })
    assert.equal(
      refused.code,
      'VALIDATION_ERROR',
    )
    assert.equal(
      s.task({ key: 'unoffered' }).agent,
      undefined,
    )
  },
)
