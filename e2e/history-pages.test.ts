import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPage } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'history defaults fit command output and continuation help preserves a custom budget',
  async () => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const create = ({
      title,
      brief = 'Release rule. '.repeat(500),
    }: {
      title: string
      brief?: string
    }) => s.owner({
      args: [
        'task',
        'create',
        '--title',
        title,
        '--brief',
        brief,
      ],
    })

    try {
      const refused = await page.refusal({
        name: 'page',
        args: ['--hydra=other-hydra'],
      })
      assert.equal(
        refused.code,
        'VALIDATION_ERROR',
      )
      assert.match(
        refused.error,
        /--hydra is not allowed/,
      )
      await create({ title: 'First release' })
      await create({ title: 'Second release' })
      await create({
        title: 'Third release',
        brief: '\n"\\'.repeat(2600),
      })
      await create({
        title: 'Fourth release',
        brief: '\n"\\'.repeat(2600),
      })
      const normal = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'origin',
        ],
      })
      assert.equal(
        normal.budget,
        6000,
      )
      assert.equal(
        normal.more,
        true,
      )
      assert.ok(new TextEncoder().encode(JSON.stringify(normal)).length < 25000)
      const small = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'origin',
          '--budget',
          '2000',
        ],
      })
      assert.equal(
        small.budget,
        2000,
      )
      assert.equal(
        small.more,
        true,
      )
      assert.match(
        String(small.help),
        /--budget 2000/,
      )
      const next = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'origin',
          '--budget',
          '2000',
          '--after',
          String(small.after),
        ],
      })
      assert.notEqual(
        next.after,
        small.after,
      )
      assert.equal(
        next.budget,
        2000,
      )
      assert.ok(new TextEncoder().encode(JSON.stringify(next)).length < 25000)
      const summary = await s.owner({ args: ['page'] })
      assert.ok(
        summary.length < 2000,
        'the default page output is a bounded summary',
      )
      assert.match(
        summary,
        /none: every card found/,
      )
      assert.match(
        summary,
        /page --full/,
      )
      assert.match(
        await s.owner({
          args: [
            'page',
            '--card',
            'task-missing',
          ],
        }),
        /unavailable.*task-missing/,
      )
      const full = await s.owner({
        args: [
          'page',
          '--full',
        ],
      })
      assert.ok(full.includes('Release rule.'))
    } finally {
      page.close()
    }
  },
)

test(
  'a page whose opened cards are not readable still connects and runs commands',
  async () => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
      rawPage: 'not-json',
    })

    try {
      await page.command({
        name: 'page',
        args: [],
      })
    } finally {
      page.close()
    }
  },
)

test(
  'a page reads a card\'s updates newest first, a page at a time, over its own socket',
  async t => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'First name',
        '--key',
        'ship',
      ],
    })

    for (const title of [
      'Second name',
      'Third name',
      'Fourth name',
    ]) {
      await s.owner({
        args: [
          'task',
          'rename',
          'ship',
          '--title',
          title,
        ],
      })
    }

    const newest = await page.command({
      name: 'task',
      args: [
        'updates',
        'ship',
        '--limit',
        '2',
      ],
    }) as {
      events: { seq: number }[]
      older?: number
    }
    const rest = await page.command({
      name: 'task',
      args: [
        'updates',
        'ship',
        '--limit',
        '50',
        '--before',
        String(newest.older),
      ],
    }) as {
      events: { seq: number }[]
      older?: number
    }

    assert.equal(
      newest.events.length,
      2,
    )
    assert.equal(
      newest.older,
      newest.events.at(-1)!.seq,
    )
    assert.ok(rest.events.every(event => event.seq < newest.older!))
    assert.ok(rest.events.length >= 1)
    assert.equal(
      rest.older,
      undefined,
    )
    const refused = await page.refusal({
      name: 'task',
      args: [
        'updates',
        'ship',
        '--limit',
        '5000',
      ],
    })
    assert.equal(
      refused.code,
      'VALIDATION_ERROR',
    )
  },
)
