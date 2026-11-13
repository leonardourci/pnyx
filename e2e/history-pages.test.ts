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
  'a page that opens with a hidden card gets it in its first snapshot and no second one',
  async () => {
    const s = await pnyx.scenario()
    const created = await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Hidden release',
      ],
    })
    const id = /task-[0-9a-f-]+/.exec(created)![0]
    await s.owner({
      args: [
        'task',
        'hide',
        id,
      ],
    })
    const args = [
      '--card',
      id,
    ]
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
      page: args,
    })

    try {
      await page.shows({
        what: 'the hidden card in the first snapshot',
        check: ({ state }) => state.cards[id]?.hidden,
      })
      await page.command({
        name: 'page',
        args,
      })
      assert.equal(
        page.snapshots(),
        1,
      )
    } finally {
      page.close()
    }
  },
)

test(
  'a page whose opened cards are not readable still gets the default snapshot',
  async () => {
    const s = await pnyx.scenario()
    const created = await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Shown release',
      ],
    })
    const id = /task-[0-9a-f-]+/.exec(created)![0]
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
      rawPage: 'not-json',
    })

    try {
      await page.shows({
        what: 'the default snapshot',
        check: ({ state }) => state.cards[id],
      })
      assert.equal(
        page.snapshots(),
        1,
      )
    } finally {
      page.close()
    }
  },
)
