import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dateLearnings, expiredLearning, staleLearnings } from '../src/memory/learnings.ts'

test(
  'editing a document dates only new or changed learning lines',
  () => {
    const before = dateLearnings({
      after: 'Old fact\nStill true',
      at: '2026-09-01T00:00:00Z',
    })
    const after = dateLearnings({
      before,
      after: 'Still true\nChanged fact',
      at: '2026-10-22T00:00:00Z',
    })
    assert.deepEqual(
      after,
      [
        {
          text: 'Still true',
          at: '2026-09-01T00:00:00Z',
        },
        {
          text: 'Changed fact',
          at: '2026-10-22T00:00:00Z',
        },
      ],
    )
    assert.deepEqual(
      staleLearnings({
        lines: after,
        now: '2026-10-22T00:00:00Z',
      }).map(line => line.text),
      ['Still true'],
    )
  },
)

test(
  'confirmation needs evidence and refreshes only the named learning',
  () => {
    const before = dateLearnings({
      after: 'One\nTwo',
      at: '2026-09-01T00:00:00Z',
    })
    assert.throws(
      () => dateLearnings({
        before,
        after: 'One\nTwo',
        at: '2026-10-22T00:00:00Z',
        confirmed: 'One',
      }),
      /evidence/,
    )
    const after = dateLearnings({
      before,
      after: 'One\nTwo',
      at: '2026-10-22T00:00:00Z',
      confirmed: 'One',
      evidence: 'The successful task reproduced this today',
    })
    assert.equal(
      after[0]!.at,
      '2026-10-22T00:00:00Z',
    )
    assert.equal(
      after[1]!.at,
      '2026-09-01T00:00:00Z',
    )
    assert.throws(
      () => dateLearnings({
        before,
        after: 'One',
        at: '2026-10-22T00:00:00Z',
        confirmed: 'Absent',
        evidence: 'Observed',
      }),
      /existing/,
    )
  },
)

test(
  'owner memory replay preserves line ages and keeps confirmation evidence in its log',
  async () => {
    const {
      mkdtempSync,
      readFileSync,
      rmSync,
    } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const {
      ownerMemory,
      saveOwnerMemory,
    } = await import('../src/store/owner-memory.ts')
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-learning-test-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home

    try {
      saveOwnerMemory({
        key: 'learnings',
        after: 'One\nTwo',
        meta: {
          actor: 'cli',
          at: '2026-09-01T00:00:00Z',
        },
      })
      saveOwnerMemory({
        key: 'learnings',
        after: 'One\nThree',
        meta: {
          actor: 'cli',
          at: '2026-10-22T00:00:00Z',
        },
      })
      assert.equal(
        ownerMemory().learnings!.lines![0]!.at,
        '2026-09-01T00:00:00Z',
      )
      saveOwnerMemory({
        key: 'learnings',
        after: 'One\nThree',
        confirmed: 'One',
        meta: {
          actor: 'cli',
          at: '2026-10-23T00:00:00Z',
          reason: 'Observed in the successful task today',
        },
      })
      assert.equal(
        ownerMemory().learnings!.lines![0]!.at,
        '2026-10-23T00:00:00Z',
      )
      assert.ok(readFileSync(
        join(
          home,
          'owner/memory.jsonl',
        ),
        'utf8',
      ).includes('Observed in the successful task today'))
      saveOwnerMemory({
        key: 'preferences',
        after: 'Short replies',
        meta: {
          actor: 'cli',
          at: '2026-09-01T00:00:00Z',
        },
      })
      assert.equal(
        ownerMemory().preferences!.lines,
        undefined,
      )
    } finally {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'both learning tiers reach their first horizon exactly, with legacy counts starting at zero',
  () => {
    const at = '2026-10-01T00:00:00Z'

    for (const tier of [
      {
        kind: 'normal' as const,
        days: 30,
        passes: 10,
      },
      {
        kind: 'for-now' as const,
        days: 7,
        passes: 3,
      },
    ]) {
      const line = {
        text: 'Fact',
        at,
        kind: tier.kind,
        until: 'version:next',
      }
      const deadline = Date.parse(at) + tier.days * 24 * 60 * 60 * 1000
      assert.equal(
        staleLearnings({
          lines: [line],
          now: new Date(deadline - 1).toISOString(),
        }).length,
        0,
      )
      assert.equal(
        staleLearnings({
          lines: [line],
          now: new Date(deadline).toISOString(),
        }).length,
        1,
      )
      assert.equal(
        staleLearnings({
          lines: [
            {
              ...line,
              passes: tier.passes - 1,
            },
          ],
          now: at,
        }).length,
        0,
      )
      assert.equal(
        staleLearnings({
          lines: [
            {
              ...line,
              passes: tier.passes,
            },
          ],
          now: at,
        }).length,
        1,
      )
    }

    assert.equal(
      staleLearnings({
        lines: [
          {
            text: 'Legacy',
            at,
          },
        ],
        now: at,
      }).length,
      0,
    )

    for (const until of [
      undefined,
      '',
      'soon',
      'date:2026-02-30',
      'task:missing-hydra',
      'version:',
    ]) {
      assert.throws(
        () => dateLearnings({
          after: 'Short-lived',
          at,
          change: {
            kind: 'for-now',
            until,
          },
        }),
        /until/,
      )
    }
  },
)

test(
  'a for-now date expires exactly at midnight UTC',
  () => {
    const line = dateLearnings({
      after: 'Before the release',
      at: '2026-10-23T12:00:00Z',
      change: {
        kind: 'for-now',
        until: 'date:2026-10-24',
      },
    })[0]!
    assert.equal(
      expiredLearning({
        line,
        now: '2026-10-23T23:59:59.999Z',
      }),
      false,
    )
    assert.equal(
      expiredLearning({
        line,
        now: '2026-10-24T00:00:00.000Z',
      }),
      true,
    )
    assert.equal(
      line.passes ?? 0,
      0,
    )
  },
)
