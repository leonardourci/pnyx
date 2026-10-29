import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { searchPath, type Hit } from '#oracle/index.ts'
import { openPage } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

const ask = async ({
  page,
  words,
}: {
  page: Awaited<ReturnType<typeof openPage>>
  words: string
}) => (await page.command({
  name: 'oracle',
  args: [
    words,
    '',
    'hydra',
  ],
})).hits as Hit[]

test(
  'the Oracle answers from an index the server builds and keeps current outside its own process',
  async t => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Deploy the billing service',
        '--key',
        'billing',
      ],
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())

    assert.deepEqual(
      (await ask({
        page,
        words: 'billing',
      })).map(hit => hit.card),
      [s.task({ key: 'billing' }).id],
      'a first query waits for the first build',
    )
    assert.ok(existsSync(searchPath({ hydraId: s.hydraId })))

    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Refund annual billing plans',
        '--key',
        'refunds',
      ],
    })
    await page.shows({
      what: 'the new task on the page',
      check: ({ state }) => !!state.cards[s.task({ key: 'refunds' }).id],
    })
    assert.deepEqual(
      (await ask({
        page,
        words: 'refund',
      })).map(hit => hit.card),
      [s.task({ key: 'refunds' }).id],
      'a query on an index behind the log waits for it to catch up',
    )
  },
)
